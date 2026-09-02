import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import { captureCli, sandboxEnv, stubAgent, stubGh, tempRepo, type StubAgent, type TempRepo } from './helpers.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../src/cli/output.js';
import { MARKER_PREFIX } from '../src/gh/comment.js';
import { bandFor, maxScore } from '../src/risk/signals.js';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, SIGNAL_NAMES, defaultRepoConfig } from '../src/risk/repoconfig.js';
import { driftSignalValue, measureDrift, parseComparison, parseDescription } from '../src/spot/drift.js';
import { driftComparePrompt, driftDescribePrompt } from '../src/spot/prompt.js';
import { Database } from '../src/db/db.js';

/**
 * Intent against diff.
 *
 * Two acceptance conditions live here.
 *
 * **Drift is shown rather than enforced.** `eyes-on drift` exits 0 for a grade
 * of 5 exactly as it does for a grade of 1, with `--strict` or without it,
 * because that command computes no band. `eyes-on check` without `--strict`
 * exits 0 at every grade too. The one exception is stated rather than implied:
 * S7 is part of the score and the band is a function of the score, so under
 * `check --strict` a drift grade gates through the band exactly like every
 * other signal. Both halves are asserted, so neither can regress into the
 * other.
 *
 * **The mechanism is two passes rather than one**, which is checked the only
 * way it can be - by reading the prompts the model was actually given and
 * asserting that the first never contained the intent and the second never
 * contained the diff.
 *
 * And one invariant, because three rounds of review found three holes in it:
 * **the score, the maximum it was computed against, the band and the grade are
 * four facts about one assessment.** A command that moves one recomputes the
 * rest, and every surface reads all four from the recorded row.
 */

const INTENT = 'Stop the mailbox poller retrying forever when the upstream returns 429.';

function describeAnswer(): string {
  return JSON.stringify({
    describes: [
      'The retry loop now stops after a fixed number of attempts.',
      'A new counter is written to the run record.',
      'The panel server gained an unrelated health endpoint.',
    ],
  });
}

function compareAnswer(grade: number): string {
  return JSON.stringify({
    drift: grade,
    missing_from_diff: [],
    unrequested_in_diff: ['A health endpoint was added to the panel server, which the intent never mentioned.'],
  });
}

test('the first pass never sees the intent and the second never sees the diff', () => {
  const diff = '@@ -1 +1 @@\n-const retries = Infinity;\n+const retries = 5;';
  const describe = driftDescribePrompt(diff);
  assert.match(describe, /You are NOT told why it was made/);
  assert.ok(describe.includes(diff), 'the first pass is given the change');
  assert.ok(!describe.includes(INTENT), 'and is not told what it was for');

  const compare = driftComparePrompt(['The retry loop now stops after five attempts.'], INTENT);
  assert.ok(compare.includes(INTENT));
  assert.ok(!compare.includes('const retries'), 'the second pass cannot re-read the code and agree with itself');
  assert.match(compare, /1 - the change does what the intent says/);
  assert.match(compare, /5 - the change and the intent are about different things/);
});

test('a diff too large for the prompt is cut, and the cut is stated rather than silent', () => {
  // Measured on a real change: git orders its diff by path, so an unmarked cut
  // handed the model the two documentation files at the top of the alphabet and
  // nothing else. It described those, and the comparison that followed reported
  // that four of the five things the change actually did were missing from it -
  // a confidently wrong grade rather than a missing one.
  const files = [
    { path: 'AGENTS.md', added: 40, deleted: 3 },
    { path: 'src/zzz/late.ts', added: 900, deleted: 12 },
    { path: 'src/zzz/binary.png', added: 0, deleted: 0 },
  ];
  const huge = `--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1 @@\n${'+documentation line\n'.repeat(4000)}`;

  const cut = driftDescribePrompt(huge, files);
  assert.match(cut, /CUT AT THE PROMPT SIZE LIMIT/);
  assert.match(cut, /EVERY FILE THE CHANGE TOUCHES \(3, complete\)/);
  // Every file is named even though its diff text is not in the prompt.
  assert.match(cut, /\+900 -12\tsrc\/zzz\/late\.ts/);
  assert.match(cut, /binary\tsrc\/zzz\/binary\.png/);
  assert.match(cut, /Cover the change as a whole/);

  // A diff that fits says so, rather than warning about a cut that did not
  // happen - a diagnostic must describe the state the code is actually in.
  const whole = driftDescribePrompt('@@ -1 +1 @@\n-a\n+b', files);
  assert.match(whole, /THE DIFF, IN FULL/);
  assert.doesNotMatch(whole, /CUT AT THE PROMPT SIZE LIMIT/);

  // The cut is decided by the budget, not by comparing the two strings: the
  // notice replacing the tail is itself forty characters, so at one diff size a
  // length comparison calls a truncated prompt complete. That is D8's failure -
  // a truncation the model cannot see - coming back through the check for it.
  const exactly = 'x'.repeat(40_040);
  const cutAgain = driftDescribePrompt(exactly, files);
  assert.match(cutAgain, /CUT AT THE PROMPT SIZE LIMIT/);
  assert.doesNotMatch(cutAgain, /THE DIFF, IN FULL/);
  assert.ok(!cutAgain.includes(exactly), 'and the whole diff is not in the prompt it labelled');
});

test('the two passes are two calls, and the second is given the first one\'s answer', () => {
  const agent = stubAgent('drift-passes', [describeAnswer(), compareAnswer(3)]);
  const result = measureDrift({
    diff: '@@ -1 +1 @@\n-const retries = Infinity;\n+const retries = 5;',
    intent: INTENT,
    model: { agent: agent.agent, command: null, allowAnyCommand: false, env: { ...process.env, PATH: agent.path } },
  });

  assert.equal(result.grade, 3);
  assert.deepEqual(result.passes, { describe: 'ok', compare: 'ok' });
  assert.equal(result.describes.length, 3);
  assert.equal(result.unrequested_in_diff.length, 1);

  const prompts = agent.prompts();
  assert.equal(prompts.length, 2, 'exactly two calls');
  assert.ok(!(prompts[0] ?? '').includes(INTENT));
  assert.ok((prompts[1] ?? '').includes(INTENT));
  assert.ok((prompts[1] ?? '').includes('The panel server gained an unrelated health endpoint.'));
});

test('a first pass that answers with nothing readable stops before the second call', () => {
  const agent = stubAgent('drift-half', ['not json at all', compareAnswer(2)]);
  const result = measureDrift({
    diff: '@@ -1 +1 @@\n-a\n+b',
    intent: INTENT,
    model: { agent: agent.agent, command: null, allowAnyCommand: false, env: { ...process.env, PATH: agent.path } },
  });
  assert.equal(result.grade, null);
  assert.deepEqual(result.passes, { describe: 'failed', compare: 'skipped' });
  assert.equal(agent.prompts().length, 1, 'the second call is not made on a broken first answer');
});

test('a grade outside 1..5 is not a grade', () => {
  assert.equal(parseComparison(JSON.stringify({ drift: 0 })), null);
  assert.equal(parseComparison(JSON.stringify({ drift: 6 })), null);
  assert.equal(parseComparison('{}'), null);
  assert.equal(parseComparison('nothing here'), null);
  assert.equal(parseComparison(JSON.stringify({ drift: 4 }))?.grade, 4);
  // Lists are lists. A joined string would break on the first sentence with a
  // separator in it, and every entry here is a sentence.
  assert.deepEqual(
    parseComparison(JSON.stringify({ drift: 2, missing_from_diff: ['one', 'two'], unrequested_in_diff: [] }))?.missing,
    ['one', 'two'],
  );
});

test('the description survives being wrapped in prose', () => {
  assert.deepEqual(parseDescription('Sure:\n```json\n{"describes":["a","b"]}\n```'), ['a', 'b']);
  assert.deepEqual(parseDescription('nothing'), []);
});

test('S7 charges drift above an aligned change, and nothing for an unmeasured one', () => {
  assert.equal(driftSignalValue(1), 0);
  assert.equal(driftSignalValue(3), 2);
  assert.equal(driftSignalValue(5), 4);
  assert.equal(driftSignalValue(null), 0);
});

// --- end to end, through the CLI -------------------------------------------

function repoWith(agent: StubAgent): TempRepo {
  const repo = tempRepo('drift');
  repo.commitFiles('chore: configure eyes-on', {
    '.eyes-on.yml': ['schema: eyes-on/v1', 'model:', `  agent: ${agent.agent}`, ''].join('\n'),
    'src/poller.ts': 'export const retries = Infinity;\n',
  });
  repo.git(['checkout', '-q', '-b', 'work']);
  repo.commitFiles('fix: bound the retries', {
    'src/poller.ts': 'export const retries = 5;\n',
    'src/panel.ts': 'export const health = () => "ok";\n',
  });
  return repo;
}

async function initRepo(t: TestContext, repo: TempRepo, env: Record<string, string>): Promise<void> {
  await captureCli(['init'], { cwd: repo.path, env });
  t.after(async () => {
    await captureCli(['daemon', 'stop'], { cwd: repo.path, env });
  });
}

interface DriftDoc {
  drift: number | null;
  state: string;
  pass_describe: string;
  pass_compare: string;
  describes: string[];
  missing_from_diff: string[];
  unrequested_in_diff: string[];
  exit_code: number;
  check_id: string | null;
}

test('acceptance: drift is shown and changes no exit code, at any grade', async (t) => {
  for (const grade of [1, 5]) {
    const agent = stubAgent(`drift-exit-${grade}`, [describeAnswer(), compareAnswer(grade)]);
    const repo = repoWith(agent);
    const env: Record<string, string> = { ...sandboxEnv(`drift-exit-${grade}`), PATH: agent.path };
    await initRepo(t, repo, env);

    await captureCli(['check', '--format', 'json'], { cwd: repo.path, env });
    const result = await captureCli(['drift', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env });
    const doc = JSON.parse(result.out) as DriftDoc;

    assert.equal(doc.drift, grade);
    assert.equal(result.code, EXIT_OK, `a drift of ${grade} still exits 0`);
    assert.equal(doc.exit_code, EXIT_OK);

    // `--strict` does not turn this command into a gate either: it computes no
    // band, so there is nothing here for `--strict` to act on. What `check
    // --strict` does with the same grade is a different question, asserted by
    // the test below.
    const strict = await captureCli(['drift', '--intent', INTENT, '--strict', '--format', 'json'], {
      cwd: repo.path,
      env,
    });
    assert.equal(strict.code, EXIT_OK);
  }
});

test('acceptance: the drift grade gates only through the band, and only when --strict asks it to', async (t) => {
  // Three describe/compare pairs, because each `check --intent` measures drift
  // with two calls and the stub answers in order.
  const agent = stubAgent('drift-strict', [
    describeAnswer(),
    compareAnswer(5),
    describeAnswer(),
    compareAnswer(5),
    describeAnswer(),
    compareAnswer(5),
  ]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-strict'), PATH: agent.path };
  await initRepo(t, repo, env);

  interface CheckDoc {
    score: number;
    band: string;
    drift: number | null;
    exit_code: number;
    signals: { name: string; points: number }[];
  }
  const check = async (argv: string[]): Promise<{ doc: CheckDoc; code: number }> => {
    const result = await captureCli(['check', ...argv, '--format', 'json'], { cwd: repo.path, env });
    return { doc: JSON.parse(result.out) as CheckDoc, code: result.code };
  };

  // What the change scores without drift, and what it scores with a grade of 5.
  const withoutDrift = (await check(['--no-model'])).doc;
  const withDrift = (await check(['--intent', INTENT])).doc;
  assert.equal(withDrift.drift, 5);
  assert.ok(
    withDrift.score > withoutDrift.score,
    `a drift of 5 raises the score (${withoutDrift.score} -> ${withDrift.score})`,
  );

  // Put `full_review` between the two, on the default branch, so the drift
  // grade is the only thing in this change that can cross it. The threshold is
  // a repository configuration field; nothing about the scoring moves.
  const full = Math.max(2, withoutDrift.score + 1);
  assert.ok(withDrift.score >= full, 'the grade alone carries the change over the threshold');
  repo.git(['checkout', '-q', 'main']);
  repo.commitFiles('chore: narrow the full-review threshold', {
    '.eyes-on.yml': [
      'schema: eyes-on/v1',
      'model:',
      `  agent: ${agent.agent}`,
      `thresholds: { read_fragments: ${full - 1}, full_review: ${full} }`,
      '',
    ].join('\n'),
  });
  repo.git(['checkout', '-q', 'work']);

  // Without --strict the exit code is 0 however far the drift carried the band.
  const measured = await check(['--intent', INTENT]);
  assert.equal(measured.doc.drift, 5);
  assert.equal(measured.doc.band, 'pelna', 'the grade moved the band, which is what a signal does');
  assert.equal(measured.code, EXIT_OK, 'a drift-driven `pelna` still exits 0 without --strict');
  assert.equal(measured.doc.exit_code, EXIT_OK);

  // With --strict the band decides, and drift reached it like any other signal.
  const strict = await check(['--intent', INTENT, '--strict']);
  assert.equal(strict.doc.band, 'pelna');
  assert.equal(strict.code, EXIT_ERROR, '--strict is the caller asking to gate on a `pelna` band');
  assert.equal(strict.doc.exit_code, EXIT_ERROR);

  // And the same change with no drift measured stays below the threshold, which
  // is what makes the line above evidence about drift rather than about the
  // threshold being low. It needs a state root where no grade was ever taken of
  // this change: within the first one `--no-model` now carries the grade
  // already measured rather than dropping back to zero, which is the point of
  // the test below this one.
  const fresh: Record<string, string> = { ...sandboxEnv('drift-strict-fresh'), PATH: agent.path };
  await initRepo(t, repo, fresh);
  const unmeasured = JSON.parse(
    (await captureCli(['check', '--intent', INTENT, '--no-model', '--strict', '--format', 'json'], {
      cwd: repo.path,
      env: fresh,
    })).out,
  ) as { score: number; band: string; drift: number | null; drift_provenance: string };
  assert.equal(unmeasured.drift, null);
  assert.equal(unmeasured.drift_provenance, 'none', 'nothing measured and nothing to carry');
  assert.notEqual(unmeasured.band, 'pelna');
  assert.equal(
    (await captureCli(['check', '--intent', INTENT, '--no-model', '--strict'], { cwd: repo.path, env: fresh })).code,
    EXIT_OK,
  );
});

test('the grade and both lists are recorded against the check, as rows rather than as one string', async (t) => {
  const agent = stubAgent('drift-record', [describeAnswer(), compareAnswer(3)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-record'), PATH: agent.path };
  await initRepo(t, repo, env);

  await captureCli(['check', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(
    (await captureCli(['drift', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env })).out,
  ) as DriftDoc;

  assert.equal(doc.drift, 3);
  assert.equal(doc.state, 'measured');
  assert.equal(doc.describes.length, 3);
  assert.ok(doc.check_id);

  const db = Database.open(join(env.EYES_HOME as string, 'state.sqlite'));
  const row = db.get<{ drift: number; intent: string }>('SELECT drift, intent FROM checks WHERE id = ?', doc.check_id);
  const items = db.all<{ kind: string; item: string }>('SELECT kind, item FROM drift_items ORDER BY kind, position');
  db.close();

  assert.equal(row?.drift, 3);
  assert.equal(row?.intent, INTENT);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, 'unrequested_in_diff');
  assert.match(items[0]?.item ?? '', /health endpoint/);
});

test('acceptance: after drift, the score, its maximum, the band and the grade agree on the row and on every surface', async (t) => {
  // The invariant this whole file exists to protect: those four numbers are
  // facts about one assessment. `drift` used to write the grade onto a row
  // whose score had been computed with S7 at zero, so `status` printed a score
  // that did not contain the grade printed under it. Whoever moves one of the
  // four now recomputes the others, and every surface reads them from the row.
  const agent = stubAgent('drift-agree', [
    describeAnswer(),
    compareAnswer(5),
    describeAnswer(),
    compareAnswer(5),
    describeAnswer(),
    compareAnswer(5),
  ]);
  const repo = repoWith(agent);
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  const gh = stubGh('drift-agree', { slug: 'acme/widgets', number: 7, headSHA: head, body: 'no-mistakes owns this body\n' });
  const env: Record<string, string> = {
    ...sandboxEnv('drift-agree'),
    PATH: `${agent.dir}${delimiter}${gh.path}`,
  };
  await initRepo(t, repo, env);

  interface Four {
    score: number;
    score_max: number;
    band: string;
    drift: number | null;
  }

  // A check with no intent: S7 is zero and the recorded score does not contain
  // a grade, because none was measured.
  const before = JSON.parse(
    (await captureCli(['check', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as Four & { check_id: string };
  assert.equal(before.drift, null);

  const drifted = JSON.parse(
    (await captureCli(['drift', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env })).out,
  ) as DriftDoc & Four;
  assert.equal(drifted.drift, 5);
  assert.ok(drifted.check_id);
  assert.ok(drifted.score > before.score, 'the grade was folded into the score, not written beside it');

  // The row, and its own internal consistency: the score is the weighted sum of
  // the signal rows recorded with it, the band is the one that score produces,
  // and the denominator is the one those weights allow.
  const db = Database.open(join(env.EYES_HOME as string, 'state.sqlite'));
  const row = db.get<Four>('SELECT score, score_max, band, drift FROM checks WHERE id = ?', drifted.check_id);
  const signals = db.all<{ name: string; raw: number; normalized: number }>(
    'SELECT name, raw, normalized FROM signals WHERE check_id = ?',
    drifted.check_id,
  );
  db.close();

  assert.ok(row);
  assert.equal(row.drift, 5);
  const byName = new Map(signals.map((signal) => [signal.name, signal.normalized]));
  assert.equal(byName.size, SIGNAL_NAMES.length, 'every signal was recorded with the score');
  assert.equal(
    signals.find((signal) => signal.name === 'drift')?.raw,
    4,
    'S7 is the grade above an aligned 1, and it is in the recorded signal rows',
  );
  const summed = Math.round(
    SIGNAL_NAMES.reduce((total, name) => total + DEFAULT_WEIGHTS[name] * (byName.get(name) ?? 0), 0) * 100,
  );
  assert.equal(row.score, summed, 'the recorded score is the weighted sum of the recorded signals, S7 included');
  assert.equal(row.band, bandFor(row.score, DEFAULT_THRESHOLDS), 'the band is the one that score produces');
  assert.equal(row.score_max, maxScore(defaultRepoConfig()), 'the denominator is the one those weights allow');

  const four = (value: Four): Four => ({
    score: value.score,
    score_max: value.score_max,
    band: value.band,
    drift: value.drift,
  });
  const expected = four(row);

  // Surface 1: the command that measured it.
  assert.deepEqual(four(drifted), expected);

  // Surface 2: status, which reads the row and nothing else.
  const status = JSON.parse((await captureCli(['status', '--format', 'json'], { cwd: repo.path, env })).out) as {
    last_check: { score: number; score_max: number | null; band: string } | null;
  };
  assert.equal(status.last_check?.score, expected.score);
  assert.equal(status.last_check?.score_max, expected.score_max);
  assert.equal(status.last_check?.band, expected.band);
  const statusMd = (await captureCli(['status', '--format', 'md'], { cwd: repo.path, env })).out;
  assert.match(statusMd, new RegExp(`\\*\\*${expected.score}/${expected.score_max} - `));

  // Surface 3: the published comment, in its payload, its prose and its marker.
  const comment = JSON.parse(
    (await captureCli(['comment', '--pr', '7', '--dry-run', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as Four & { body: string };
  assert.deepEqual(four(comment), expected);
  assert.ok(comment.body.includes(`eyes-on - ${expected.score} of at most ${expected.score_max}`));
  assert.ok(comment.body.includes(`Intent versus diff: ${String(expected.drift)}/5`));
  const markerLine = comment.body.split('\n')[0] ?? '';
  assert.deepEqual(
    JSON.parse(markerLine.slice(MARKER_PREFIX.length, markerLine.lastIndexOf(' -->'))) as {
      score: number;
      score_max: number;
      band: string;
    },
    { head_sha: head, score: expected.score, score_max: expected.score_max, band: expected.band, decision: null, check_id: drifted.check_id },
  );

  // Surface 4: check itself, recomputing the same change with the same intent.
  const recomputed = JSON.parse(
    (await captureCli(['check', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env })).out,
  ) as Four;
  assert.deepEqual(four(recomputed), expected);
});

test('check --intent scores the drift as S7, and the same change without an intent does not', async (t) => {
  const agent = stubAgent('drift-s7', [describeAnswer(), compareAnswer(5)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-s7'), PATH: agent.path };
  await initRepo(t, repo, env);

  interface CheckDoc {
    score: number;
    drift: number | null;
    drift_state: string;
    signals: { name: string; raw: number; weight: number; points: number }[];
    exit_code: number;
  }

  const without = JSON.parse((await captureCli(['check', '--format', 'json'], { cwd: repo.path, env })).out) as CheckDoc;
  assert.equal(without.drift, null);
  assert.match(without.drift_state, /no --intent/);
  assert.equal(without.signals.find((signal) => signal.name === 'drift')?.points, 0);
  assert.equal(agent.called(), false, 'no intent, no model call');

  const withIntent = JSON.parse(
    (await captureCli(['check', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CheckDoc;
  const s7 = withIntent.signals.find((signal) => signal.name === 'drift');
  assert.equal(withIntent.drift, 5);
  assert.equal(s7?.weight, 0.2);
  assert.equal(s7?.raw, 4, 'the grade above an aligned 1');
  assert.ok((s7?.points ?? 0) > 0);
  assert.equal(withIntent.score, without.score + (s7?.points ?? 0));
  // Raising the score is not blocking here: without --strict the exit code is
  // unchanged whatever the band became.
  assert.equal(withIntent.exit_code, EXIT_OK);
});

test('status shows a drift-inflated score against the maximum it was computed under, not against 100', async (t) => {
  // Drift is weighted 0.20 on top of six signals that already total 1.00, so a
  // score can pass 100 and `n/100` would be a rendering of a number that does
  // not exist. The denominator is recorded with the score rather than
  // recomputed at display time, so it cannot drift away from what it describes.
  const agent = stubAgent('drift-status', [describeAnswer(), compareAnswer(5)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-status'), PATH: agent.path };
  await initRepo(t, repo, env);

  const check = JSON.parse(
    (await captureCli(['check', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env })).out,
  ) as { score: number; score_max: number; drift: number };
  assert.equal(check.drift, 5);
  assert.equal(check.score_max, 120, 'the six history signals plus drift at 0.20');

  const doc = JSON.parse((await captureCli(['status', '--format', 'json'], { cwd: repo.path, env })).out) as {
    last_check: { score: number; score_max: number | null } | null;
  };
  assert.equal(doc.last_check?.score, check.score);
  assert.equal(doc.last_check?.score_max, check.score_max, 'the payload carries a denominator an agent can read');

  const markdown = (await captureCli(['status', '--format', 'md'], { cwd: repo.path, env })).out;
  assert.match(markdown, new RegExp(`\\*\\*${check.score}/${check.score_max} - `));
  assert.doesNotMatch(markdown, /\/100 - /, 'the literal hundred is not the maximum any more');
});

test('a check recorded before the maximum was stored says so rather than assuming 100', async (t) => {
  const agent = stubAgent('drift-nomax', [describeAnswer(), compareAnswer(5)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-nomax'), PATH: agent.path };
  await initRepo(t, repo, env);

  await captureCli(['check', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env });

  // What a row written by an earlier version looks like: a score, and no
  // maximum beside it.
  const db = Database.open(join(env.EYES_HOME as string, 'state.sqlite'));
  db.run('UPDATE checks SET score_max = NULL');
  db.close();

  const doc = JSON.parse((await captureCli(['status', '--format', 'json'], { cwd: repo.path, env })).out) as {
    last_check: { score_max: number | null } | null;
  };
  assert.equal(doc.last_check?.score_max, null);

  const markdown = (await captureCli(['status', '--format', 'md'], { cwd: repo.path, env })).out;
  assert.doesNotMatch(markdown, /\/100/, 'a denominator nobody recorded is not invented');
  assert.match(markdown, /before eyes-on stored the maximum/);
});

test('acceptance: a grade measured against a different intent is dropped, not inherited', async (t) => {
  // A drift grade measures the pair (diff, intent), and the row it lives on is
  // keyed by (repository, base, head) - the intent is outside that key. The
  // author changed what the change is FOR, so the previous verdict answers a
  // different question and carrying it would be evidence saying something
  // untrue about what was measured.
  const OTHER = 'Add the health endpoint the panel needs, and nothing else.';
  const agent = stubAgent('check-question', [describeAnswer(), compareAnswer(5)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('check-question'), PATH: agent.path };
  await initRepo(t, repo, env);

  interface CheckDoc {
    check_id: string;
    score: number;
    band: string;
    drift: number | null;
    drift_intent: string | null;
    drift_provenance: string;
    drift_sentence: string;
    drift_state: string;
  }
  const check = async (argv: string[]): Promise<CheckDoc> =>
    JSON.parse((await captureCli(['check', ...argv, '--format', 'json'], { cwd: repo.path, env })).out) as CheckDoc;

  const measured = await check(['--intent', INTENT]);
  assert.equal(measured.drift, 5);
  assert.equal(measured.drift_intent, INTENT);

  const dbPath = join(env.EYES_HOME as string, 'state.sqlite');
  const items = (): unknown[] => {
    const db = Database.open(dbPath);
    const rows = db.all('SELECT kind, item FROM drift_items WHERE check_id = ?', measured.check_id);
    db.close();
    return rows;
  };
  assert.equal(items().length, 1);

  // Case 1: the same intent, nothing measured - the grade is carried.
  const same = await check(['--intent', INTENT, '--no-model']);
  assert.equal(same.drift, 5);
  assert.equal(same.drift_provenance, 'carried');
  assert.equal(same.score, measured.score);
  assert.equal(items().length, 1, 'the lists of that measurement are untouched');

  // Case 2: no --intent at all - the run asks no drift question, so it moves
  // nothing and still reports the grade the row holds against its own intent.
  const silent = await check([]);
  assert.equal(silent.drift, 5);
  assert.equal(silent.drift_intent, INTENT);
  assert.equal(silent.drift_provenance, 'carried');
  assert.equal(silent.score, measured.score);
  assert.match(silent.drift_sentence, new RegExp(INTENT.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(items().length, 1);

  // ...and the recorded intent survives it, so `drift` can still find one.
  const reused = JSON.parse(
    (await captureCli(['drift', '--no-model', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as { intent: string };
  assert.equal(reused.intent, INTENT, 'a bare check did not blank the intent the grade answers');

  // Case 3: a different intent, nothing measured - the grade answers another
  // question, so it is dropped rather than inherited.
  const changed = await check(['--intent', OTHER, '--no-model']);
  assert.equal(changed.drift, null);
  assert.equal(changed.drift_provenance, 'none');
  assert.equal(changed.drift_intent, OTHER);
  assert.ok(changed.score < measured.score, 'S7 fell back to zero');
  assert.match(changed.drift_sentence, /answers a different question/);
  assert.match(changed.drift_state, /different intent/);
  assert.equal(items().length, 0, 'and the lists of the superseded measurement went with it');

  const db = Database.open(dbPath);
  const row = db.get<{ drift: number | null; drift_intent: string | null; intent: string }>(
    'SELECT drift, drift_intent, intent FROM checks WHERE id = ?',
    measured.check_id,
  );
  db.close();
  assert.equal(row?.drift, null);
  assert.equal(row?.drift_intent, OTHER);
  assert.equal(row?.intent, OTHER);
});

test('acceptance: a check that measures nothing keeps the grade already taken of this change, and says so', async (t) => {
  // Not measuring is not changing, and `check` is the command the workflow runs
  // first. A retry whose model is rate-limited used to reassess with a null
  // grade, drop the score, and delete the drift items of a measurement taken of
  // this very base..head - so the pull request published a lower risk because a
  // later run measured less.
  const agent = stubAgent('check-keeps', [describeAnswer(), compareAnswer(5)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('check-keeps'), PATH: agent.path };
  await initRepo(t, repo, env);

  interface CheckDoc {
    check_id: string;
    score: number;
    score_max: number;
    band: string;
    drift: number | null;
    drift_provenance: string;
    drift_sentence: string;
  }

  const measured = JSON.parse(
    (await captureCli(['check', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CheckDoc;
  assert.equal(measured.drift, 5);
  assert.equal(measured.drift_provenance, 'measured', 'this run took the grade itself');
  assert.doesNotMatch(measured.drift_sentence, /carried/);

  interface Recorded {
    row: { score: number; score_max: number; band: string; drift: number };
    signals: Record<string, unknown>[];
    items: Record<string, unknown>[];
  }
  const dbPath = join(env.EYES_HOME as string, 'state.sqlite');
  const readRow = (): Recorded => {
    const db = Database.open(dbPath);
    const row = db.get<Recorded['row']>('SELECT score, score_max, band, drift FROM checks WHERE id = ?', measured.check_id);
    const signals = db.all('SELECT name, raw, normalized FROM signals WHERE check_id = ? ORDER BY name', measured.check_id);
    const items = db.all('SELECT kind, position, item FROM drift_items WHERE check_id = ? ORDER BY kind, position', measured.check_id);
    db.close();
    return {
      row: { ...(row as Recorded['row']) },
      signals: signals.map((entry) => ({ ...entry })),
      items: items.map((entry) => ({ ...entry })),
    };
  };

  const before = readRow();
  assert.equal(before.row.drift, 5);
  assert.equal(before.items.length, 1, 'the measurement left an item behind');

  // The retry: same change, no model this time.
  const carried = JSON.parse(
    (await captureCli(['check', '--intent', INTENT, '--no-model', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CheckDoc;

  assert.deepEqual(readRow(), before, 'the score, its maximum, the band, the grade, the signals and the items are as they were');
  assert.equal(carried.score, before.row.score, 'the published risk did not drop');
  assert.equal(carried.band, before.row.band);
  assert.equal(carried.drift, 5);

  // And the run says the grade is not its own, because a score carrying a grade
  // this invocation did not take claims more than this invocation measured.
  assert.equal(carried.drift_provenance, 'carried');
  assert.match(carried.drift_sentence, /carried from an earlier measurement of this same change/);

  // Every surface that shows the four facts says the same thing.
  const markdown = (await captureCli(['check', '--intent', INTENT, '--no-model', '--format', 'md'], { cwd: repo.path, env })).out;
  assert.match(markdown, /carried from an earlier measurement of this same change/);
  assert.deepEqual(readRow(), before);

  const status = JSON.parse((await captureCli(['status', '--format', 'json'], { cwd: repo.path, env })).out) as {
    last_check: { score: number; band: string; drift: number; drift_provenance: string } | null;
  };
  assert.equal(status.last_check?.drift, 5);
  assert.equal(status.last_check?.score, before.row.score);
  assert.equal(status.last_check?.drift_provenance, 'carried');
  assert.match(
    (await captureCli(['status', '--format', 'md'], { cwd: repo.path, env })).out,
    /carried from an earlier measurement of this same change/,
  );
});

test('acceptance: a drift run that measures nothing moves nothing it found recorded', async (t) => {
  // Not measuring is not changing. Rescoring with a null grade would write a
  // score computed with S7 at zero over one that contains a grade taken of this
  // very base..head and delete that grade's items with it, so the risk
  // published on the pull request would drop because a later run - a rate
  // limit, or --no-model, which this command documents as supported - measured
  // nothing.
  const agent = stubAgent('drift-keeps', [describeAnswer(), compareAnswer(5)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-keeps'), PATH: agent.path };
  await initRepo(t, repo, env);

  const measured = JSON.parse(
    (await captureCli(['check', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env })).out,
  ) as { check_id: string; drift: number };
  assert.equal(measured.drift, 5);

  const dbPath = join(env.EYES_HOME as string, 'state.sqlite');
  interface Recorded {
    row: { score: number; score_max: number; band: string; drift: number };
    signals: Record<string, unknown>[];
    items: Record<string, unknown>[];
  }
  // Rows come back with a null prototype, so each is spread into a plain object
  // before it is compared with another reading or with a literal.
  const readRow = (): Recorded => {
    const db = Database.open(dbPath);
    const row = db.get<Recorded['row']>('SELECT score, score_max, band, drift FROM checks WHERE id = ?', measured.check_id);
    const signals = db.all('SELECT name, raw, normalized FROM signals WHERE check_id = ? ORDER BY name', measured.check_id);
    const items = db.all('SELECT kind, position, item FROM drift_items WHERE check_id = ? ORDER BY kind, position', measured.check_id);
    db.close();
    return {
      row: { ...(row as Recorded['row']) },
      signals: signals.map((entry) => ({ ...entry })),
      items: items.map((entry) => ({ ...entry })),
    };
  };

  const before = readRow();
  assert.equal(before.row.score_max, 120);
  assert.equal(before.row.drift, 5);
  assert.equal(before.items.length, 1, 'the measurement left an item behind');
  assert.equal(before.signals.length, SIGNAL_NAMES.length);

  const doc = JSON.parse(
    (await captureCli(['drift', '--intent', INTENT, '--no-model', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as { drift: number | null; state: string; score: number; score_max: number; band: string; recorded_drift: number; rescored: boolean };

  assert.equal(doc.drift, null, 'this run measured no grade');
  assert.equal(doc.rescored, false);
  assert.deepEqual(readRow(), before, 'the score, its maximum, the band, the grade, the signals and the items are as they were');

  // And the payload says which is which rather than reporting the run's own
  // null as the record's grade.
  assert.equal(doc.recorded_drift, 5);
  assert.equal(doc.score, before.row.score);
  assert.equal(doc.score_max, before.row.score_max);
  assert.equal(doc.band, before.row.band);

  // The Markdown says the same thing, rather than describing a rescore that did
  // not happen above a heading that says nothing was measured.
  const markdown = (await captureCli(['drift', '--intent', INTENT, '--no-model', '--format', 'md'], { cwd: repo.path, env })).out;
  assert.match(markdown, /\*\*Not measured\.\*\*/);
  assert.match(markdown, /Nothing on the recorded check moved/);
  assert.match(markdown, /answers this same intent/);
  assert.doesNotMatch(markdown, /rescored/);
  assert.deepEqual(readRow(), before);
});

test('acceptance: drift against a changed intent drops the grade, and says that rather than that nothing moved', async (t) => {
  // The supersede path, which the rule was written for and no test reached.
  // Every sentence about the record has to describe what this run actually did:
  // it lowered the score by dropping a grade that answers another question and
  // deleted that measurement's lists, which is not "nothing moved".
  const OTHER = 'Add the health endpoint the panel needs, and nothing else.';
  const agent = stubAgent('drift-superseded', [describeAnswer(), compareAnswer(5)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-superseded'), PATH: agent.path };
  await initRepo(t, repo, env);

  const measured = JSON.parse(
    (await captureCli(['check', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env })).out,
  ) as { check_id: string; score: number; band: string; drift: number };
  assert.equal(measured.drift, 5);

  const dbPath = join(env.EYES_HOME as string, 'state.sqlite');
  const items = (): unknown[] => {
    const db = Database.open(dbPath);
    const rows = db.all('SELECT kind, item FROM drift_items WHERE check_id = ?', measured.check_id);
    db.close();
    return rows;
  };
  assert.equal(items().length, 1);

  const doc = JSON.parse(
    (await captureCli(['drift', '--intent', OTHER, '--no-model', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as {
    drift: number | null;
    score: number;
    band: string;
    recorded_drift: number | null;
    record_outcome: string;
    rescored: boolean;
    recorded_changed: boolean;
    record_sentence: string;
    help: string[];
  };

  assert.equal(doc.drift, null, 'this run measured nothing');
  assert.equal(doc.record_outcome, 'superseded');
  assert.equal(doc.rescored, false, 'no grade was folded in');
  assert.equal(doc.recorded_changed, true, 'but the four numbers did move');
  assert.equal(doc.recorded_drift, null, 'the grade that answered the old intent is gone');
  assert.ok(doc.score < measured.score, `the score fell from ${measured.score} to ${doc.score}`);
  assert.equal(items().length, 0, 'and that measurement lists went with it');

  // The sentence describes the state the code is actually in, in the payload,
  // the help lines and the Markdown alike - one source, so they cannot disagree.
  assert.match(doc.record_sentence, /was measured against a different intent, so it was dropped/);
  assert.ok(doc.help.includes(doc.record_sentence), 'the help lines print the same sentence');
  assert.doesNotMatch(doc.record_sentence, /Nothing on the recorded check moved/);

  const markdown = (await captureCli(['drift', '--intent', OTHER, '--no-model', '--format', 'md'], { cwd: repo.path, env })).out;
  assert.match(markdown, /\*\*Not measured\.\*\*/);
  assert.doesNotMatch(markdown, /untouched/);
  assert.doesNotMatch(markdown, /A run that measured nothing moves none of those numbers/);
});

test('a row recorded before eyes-on stored the grade intent keeps its own intent', async (t) => {
  // Every check written before this branch looks like this: an `intent`, and no
  // `drift_intent` because the column did not exist. A bare `eyes-on check` on
  // the same base..head must keep the intent the row already holds - taking the
  // grade's intent for it would blank the column, and `eyes-on drift` would then
  // refuse with "run check --intent first", which is what the user already did.
  const agent = stubAgent('drift-migrated', [describeAnswer(), compareAnswer(3)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-migrated'), PATH: agent.path };
  await initRepo(t, repo, env);

  const measured = JSON.parse(
    (await captureCli(['check', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env })).out,
  ) as { check_id: string };

  // Back to what the older schema left behind: the grade's intent unrecorded.
  const dbPath = join(env.EYES_HOME as string, 'state.sqlite');
  const write = Database.open(dbPath);
  write.run('UPDATE checks SET drift_intent = NULL WHERE id = ?', measured.check_id);
  write.close();

  await captureCli(['check', '--format', 'json'], { cwd: repo.path, env });

  const db = Database.open(dbPath);
  const row = db.get<{ intent: string | null; drift: number | null }>(
    'SELECT intent, drift FROM checks WHERE id = ?',
    measured.check_id,
  );
  db.close();
  assert.equal(row?.intent, INTENT, 'the row kept the intent it already had');

  // And the remedy the refusal names is not needed, because there is no refusal.
  const reused = JSON.parse(
    (await captureCli(['drift', '--no-model', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as { intent: string };
  assert.equal(reused.intent, INTENT);
});

test('check --no-model with an intent measures no drift and calls no model', async (t) => {
  const agent = stubAgent('drift-nomodel', [describeAnswer(), compareAnswer(4)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-nomodel'), PATH: agent.path };
  await initRepo(t, repo, env);

  const doc = JSON.parse(
    (await captureCli(['check', '--intent', INTENT, '--no-model', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as { drift: number | null; drift_state: string };

  assert.equal(agent.called(), false);
  assert.equal(doc.drift, null);
  assert.match(doc.drift_state, /--no-model/);
});

test('drift with no intent anywhere is a usage error naming the flag, not an empty answer', async (t) => {
  const agent = stubAgent('drift-nointent', [describeAnswer(), compareAnswer(2)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-nointent'), PATH: agent.path };
  await initRepo(t, repo, env);

  const result = await captureCli(['drift', '--format', 'json'], { cwd: repo.path, env });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.out, /drift needs an intent/);
  assert.equal(agent.called(), false);
});

test('drift reuses the intent recorded by check rather than asking for it twice', async (t) => {
  const agent = stubAgent('drift-reuse', [describeAnswer(), compareAnswer(2), describeAnswer(), compareAnswer(2)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-reuse'), PATH: agent.path };
  await initRepo(t, repo, env);

  await captureCli(['check', '--intent', INTENT, '--no-model', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse((await captureCli(['drift', '--format', 'json'], { cwd: repo.path, env })).out) as DriftDoc & {
    intent: string;
  };
  assert.equal(doc.intent, INTENT);
  assert.equal(doc.drift, 2);
});

test('the intent column records whether this run stated an intent or reused the recorded one', async (t) => {
  // `intent_source` exists to say where the intent came from, and `drift` with
  // no `--intent` reuses the one already on the row. Recording that as `flag`
  // said this invocation stated an intent it was never given, and `spotlight`
  // reads the value back and rewrites it, so the wrong answer persisted.
  const agent = stubAgent('drift-source', [describeAnswer(), compareAnswer(3)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-source'), PATH: agent.path };
  await initRepo(t, repo, env);
  const dbPath = join(env.EYES_HOME as string, 'state.sqlite');
  const sourceOf = (id: string): { intent: string | null; intent_source: string | null } | undefined => {
    const db = Database.open(dbPath);
    try {
      const row = db.get<{ intent: string | null; intent_source: string | null }>(
        'SELECT intent, intent_source FROM checks WHERE id = ?',
        id,
      );
      return row ? { intent: row.intent, intent_source: row.intent_source } : undefined;
    } finally {
      db.close();
    }
  };

  await captureCli(['check', '--format', 'json'], { cwd: repo.path, env });
  const measured = JSON.parse(
    (await captureCli(['drift', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env })).out,
  ) as DriftDoc;
  assert.equal(measured.drift, 3);
  assert.deepEqual(sourceOf(measured.check_id as string), { intent: INTENT, intent_source: 'flag' });

  // No `--intent`: the intent comes off the row, so it is carried, not stated.
  const carried = JSON.parse(
    (await captureCli(['drift', '--no-model', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as DriftDoc;
  assert.deepEqual(sourceOf(carried.check_id as string), { intent: INTENT, intent_source: 'carried' });
});

test('a carried grade is published with the lists it was measured with, not with two empty ones', async (t) => {
  // An empty list is not "not measured here": it reads as the intent and the
  // diff agreeing on everything, which is the opposite of what the measurement
  // this run is carrying actually found.
  const agent = stubAgent('drift-carry-items', [describeAnswer(), compareAnswer(3)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-carry-items'), PATH: agent.path };
  await initRepo(t, repo, env);

  interface CheckDoc {
    drift: number | null;
    drift_provenance: string;
    drift_missing_from_diff: string[];
    drift_unrequested_in_diff: string[];
  }
  const measured = JSON.parse(
    (await captureCli(['check', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CheckDoc;
  assert.equal(measured.drift, 3);
  assert.equal(measured.drift_provenance, 'measured');
  assert.equal(measured.drift_unrequested_in_diff.length, 1);

  const carried = JSON.parse(
    (await captureCli(['check', '--intent', INTENT, '--no-model', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CheckDoc;
  assert.equal(carried.drift, 3, 'the grade survives a run that measured nothing');
  assert.equal(carried.drift_provenance, 'carried');
  assert.deepEqual(
    carried.drift_unrequested_in_diff,
    measured.drift_unrequested_in_diff,
    'and so do the items that grade was measured with',
  );
  assert.deepEqual(carried.drift_missing_from_diff, measured.drift_missing_from_diff);

  const markdown = (await captureCli(['check', '--intent', INTENT, '--no-model', '--format', 'md'], { cwd: repo.path, env })).out;
  assert.match(markdown, /in the change and not asked for: A health endpoint/);
});

test('a run given no intent says so, whether or not it also passed --no-model', async (t) => {
  // The reason reported has to be the one that applies: naming --no-model here
  // tells an agent that retrying with a model would produce a grade, and no
  // model produces one for a run that asked no drift question.
  const agent = stubAgent('drift-why-none', [describeAnswer(), compareAnswer(4)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-why-none'), PATH: agent.path };
  await initRepo(t, repo, env);

  const doc = JSON.parse(
    (await captureCli(['check', '--no-model', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as { drift_state: string };
  assert.equal(doc.drift_state, 'not measured: no --intent was given');
  assert.equal(agent.called(), false);

  // And the Markdown says nothing about drift on either intent-less run, rather
  // than one of the two printing a line the other suppresses.
  const withFlag = (await captureCli(['check', '--no-model', '--format', 'md'], { cwd: repo.path, env })).out;
  const without = (await captureCli(['check', '--format', 'md'], { cwd: repo.path, env })).out;
  assert.doesNotMatch(withFlag, /_Drift:/);
  assert.doesNotMatch(without, /_Drift:/);
});

test('drift reports a check recorded without a maximum as having none, rather than printing the word null', async (t) => {
  // The ordinary upgrade path: stage 1 recorded a score and no `score_max`, and
  // this run takes the branch that does not rewrite the row.
  const agent = stubAgent('drift-no-max', [describeAnswer(), compareAnswer(2)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-no-max'), PATH: agent.path };
  await initRepo(t, repo, env);
  const dbPath = join(env.EYES_HOME as string, 'state.sqlite');

  await captureCli(['check', '--format', 'json'], { cwd: repo.path, env });
  const write = Database.open(dbPath);
  write.run('UPDATE checks SET score_max = NULL');
  write.close();

  const doc = JSON.parse(
    (await captureCli(['drift', '--intent', INTENT, '--no-model', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as { record_sentence: string; help: string[] };
  const markdown = (await captureCli(['drift', '--intent', INTENT, '--no-model', '--format', 'md'], { cwd: repo.path, env })).out;

  assert.doesNotMatch(doc.record_sentence, /at most null/);
  assert.doesNotMatch(markdown, /at most null/);
  assert.match(doc.record_sentence, /no denominator here/);
  assert.ok(doc.help.includes(doc.record_sentence), 'the help lines print the same sentence');
});

test('an empty --intent states nothing, so it keeps a grade rather than superseding it', async (t) => {
  // Whitespace alone is not a changed question. It used to reach carryDrift as
  // one, which dropped a grade measured of this very change and deleted its
  // lists - the failure the supersede rule exists to prevent.
  const agent = stubAgent('drift-blank', [describeAnswer(), compareAnswer(3)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-blank'), PATH: agent.path };
  await initRepo(t, repo, env);
  const dbPath = join(env.EYES_HOME as string, 'state.sqlite');

  interface Four {
    score: number;
    score_max: number;
    band: string;
    drift: number | null;
  }
  const recorded = (): { four: Four; items: number; intent: string | null } => {
    const db = Database.open(dbPath);
    try {
      const row = db.get<Four & { intent: string | null; id: string }>(
        'SELECT id, score, score_max, band, drift, intent FROM checks',
      );
      const items = db.all<{ item: string }>('SELECT item FROM drift_items').length;
      return {
        four: { score: row?.score as number, score_max: row?.score_max as number, band: row?.band as string, drift: row?.drift ?? null },
        items,
        intent: row?.intent ?? null,
      };
    } finally {
      db.close();
    }
  };

  await captureCli(['check', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env });
  const measured = recorded();
  assert.equal(measured.four.drift, 3);
  assert.equal(measured.items, 1);

  const doc = JSON.parse(
    (await captureCli(['check', '--intent', '   ', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as { drift: number | null; drift_provenance: string; drift_state: string };

  assert.deepEqual(recorded().four, measured.four, 'the four facts did not move');
  assert.equal(recorded().items, measured.items, 'and neither did the lists');
  assert.equal(recorded().intent, INTENT, 'the row keeps the intent the grade answers');
  assert.equal(doc.drift, 3);
  assert.equal(doc.drift_provenance, 'carried');

  // Which is exactly what a run with no --intent at all does.
  const bare = JSON.parse(
    (await captureCli(['check', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as { drift: number | null; drift_provenance: string; drift_state: string };
  assert.equal(bare.drift, doc.drift);
  assert.equal(bare.drift_provenance, doc.drift_provenance);
  assert.equal(bare.drift_state, doc.drift_state);
  assert.deepEqual(recorded().four, measured.four);
});

test('drift run before any check says there is no assessment to fold the grade into', async (t) => {
  // Reachable as a first invocation: the usage error points at `check --intent`
  // as an alternative rather than a prerequisite, and both model calls are spent
  // before the grade finds nothing to be a signal of.
  const agent = stubAgent('drift-unrecorded', [describeAnswer(), compareAnswer(3)]);
  const repo = repoWith(agent);
  const env: Record<string, string> = { ...sandboxEnv('drift-unrecorded'), PATH: agent.path };
  await initRepo(t, repo, env);

  const doc = JSON.parse(
    (await captureCli(['drift', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env })).out,
  ) as DriftDoc & { score: number | null; drift_sentence: string; record_sentence: string; help: string[] };

  assert.equal(doc.drift, 3, 'the grade was measured');
  assert.equal(doc.score, null);
  assert.equal(doc.check_id, null);
  assert.doesNotMatch(doc.drift_sentence, /the score contains it/);
  assert.match(doc.drift_sentence, /no recorded assessment/);
  assert.match(doc.record_sentence, /Nothing was recorded/);
  assert.ok(!doc.help.some((line) => /folded it in/.test(line)), 'nothing claims the grade was folded into a score');
  assert.ok(doc.help.includes(doc.record_sentence));
});
