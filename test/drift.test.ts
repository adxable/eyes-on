import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { captureCli, sandboxEnv, stubAgent, tempRepo, type StubAgent, type TempRepo } from './helpers.js';
import { EXIT_OK, EXIT_USAGE } from '../src/cli/output.js';
import { driftSignalValue, measureDrift, parseComparison, parseDescription } from '../src/spot/drift.js';
import { driftComparePrompt, driftDescribePrompt } from '../src/spot/prompt.js';
import { Database } from '../src/db/db.js';

/**
 * Intent against diff.
 *
 * Two acceptance conditions live here. **Drift never gates**: the exit code is
 * 0 for a grade of 5 exactly as it is for a grade of 1, and no other command's
 * exit code moves either. And the mechanism is two passes rather than one,
 * which is checked the only way it can be - by reading the prompts the model
 * was actually given and asserting that the first never contained the intent
 * and the second never contained the diff.
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

test('the two passes are two calls, and the second is given the first one\'s answer', () => {
  const agent = stubAgent('drift-passes', [describeAnswer(), compareAnswer(3)]);
  const result = measureDrift({
    diff: '@@ -1 +1 @@\n-const retries = Infinity;\n+const retries = 5;',
    intent: INTENT,
    model: { command: agent.command, allowAnyCommand: false },
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
    model: { command: agent.command, allowAnyCommand: false },
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
    '.eyes-on.yml': ['schema: eyes-on/v1', 'model:', `  command: ["${agent.command[0] as string}"]`, ''].join('\n'),
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
    const env = sandboxEnv(`drift-exit-${grade}`);
    await initRepo(t, repo, env);

    await captureCli(['check', '--format', 'json'], { cwd: repo.path, env });
    const result = await captureCli(['drift', '--intent', INTENT, '--format', 'json'], { cwd: repo.path, env });
    const doc = JSON.parse(result.out) as DriftDoc;

    assert.equal(doc.drift, grade);
    assert.equal(result.code, EXIT_OK, `a drift of ${grade} still exits 0`);
    assert.equal(doc.exit_code, EXIT_OK);

    // Not even --strict turns drift into a gate: --strict is about the band.
    const strict = await captureCli(['drift', '--intent', INTENT, '--strict', '--format', 'json'], {
      cwd: repo.path,
      env,
    });
    assert.equal(strict.code, EXIT_OK);
  }
});

test('the grade and both lists are recorded against the check, as rows rather than as one string', async (t) => {
  const agent = stubAgent('drift-record', [describeAnswer(), compareAnswer(3)]);
  const repo = repoWith(agent);
  const env = sandboxEnv('drift-record');
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

test('check --intent scores the drift as S7, and the same change without an intent does not', async (t) => {
  const agent = stubAgent('drift-s7', [describeAnswer(), compareAnswer(5)]);
  const repo = repoWith(agent);
  const env = sandboxEnv('drift-s7');
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
  // Raising the score is not blocking: the exit code is unchanged.
  assert.equal(withIntent.exit_code, EXIT_OK);
});

test('check --no-model with an intent measures no drift and calls no model', async (t) => {
  const agent = stubAgent('drift-nomodel', [describeAnswer(), compareAnswer(4)]);
  const repo = repoWith(agent);
  const env = sandboxEnv('drift-nomodel');
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
  const env = sandboxEnv('drift-nointent');
  await initRepo(t, repo, env);

  const result = await captureCli(['drift', '--format', 'json'], { cwd: repo.path, env });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.out, /drift needs an intent/);
  assert.equal(agent.called(), false);
});

test('drift reuses the intent recorded by check rather than asking for it twice', async (t) => {
  const agent = stubAgent('drift-reuse', [describeAnswer(), compareAnswer(2), describeAnswer(), compareAnswer(2)]);
  const repo = repoWith(agent);
  const env = sandboxEnv('drift-reuse');
  await initRepo(t, repo, env);

  await captureCli(['check', '--intent', INTENT, '--no-model', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse((await captureCli(['drift', '--format', 'json'], { cwd: repo.path, env })).out) as DriftDoc & {
    intent: string;
  };
  assert.equal(doc.intent, INTENT);
  assert.equal(doc.drift, 2);
});
