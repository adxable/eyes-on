import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureCli, pathWithGitOnly, sandboxEnv, tempRepo, type TempRepo } from './helpers.js';
import { EXIT_OK, EXIT_USAGE } from '../src/cli/output.js';
import { LEDGER_VERSION, type LedgerRecord } from '../src/ledger/ledger.js';
import { calibrate } from '../src/ledger/calibrate.js';
import { sampleVerdict, MIN_MERGES_PER_CHANNEL } from '../src/ledger/sample.js';
import { flagDuration, flagString, parseArgs, DURATION_FLAGS } from '../src/cli/args.js';
import { COMMANDS } from '../src/cli/commands.js';
import type { Leak } from '../src/ledger/leaks.js';
import { canonicalPath, repoID } from '../src/core/repoid.js';

/**
 * The leak measurement and the threshold sweep.
 *
 * Three acceptance conditions live here. **Methodology**: only the line-level
 * variant exists and the CLI refuses to be asked for the other one.
 * **Honesty**: below a hundred merges in a channel the header says the numbers
 * are directional. **Non-blocking**: exit 0 whatever the numbers are, with no
 * `--strict` to change that.
 *
 * The register is written directly in most tests rather than through `label`.
 * That is deliberate: `test/ledger.test.ts` proves `label` writes it, and these
 * tests need several merges across several channels, which through the command
 * would mean a fake GitHub holding a pull request per merge and would put the
 * link reconstruction on the critical path of a measurement about blame. One
 * test runs the whole chain end to end so the two halves are known to meet.
 */

const DAY = 86_400;

interface LeaksDoc {
  variant: string;
  window: string;
  since: string;
  directional: boolean;
  sample_sentence: string;
  merges: number;
  leaked: number;
  leak_rate: number | null;
  channels: { band: string; merges: number; leaked: number; leak_rate: number | null; directional: boolean }[];
  leaks: { pr: number; band: string; merge: string; fix: string; days_after_merge: number; blamed_lines: number }[];
  excluded: { pr: number; merge: string | null; reason: string }[];
  unverified: number;
  parked: number;
  merged_on_branch: number;
  registered: number;
  ledger_absent: boolean;
  ledger_lines_skipped: number;
  exit_code: number;
  help: string[];
}

interface CalibrateDoc {
  merges: number;
  leaked: number;
  score_max: number;
  directional: boolean;
  sample_sentence: string;
  current_read_fragments: number | null;
  current_full_review: number | null;
  candidate_read_fragments: number | null;
  candidate_blocked: string | null;
  rows_considered: number;
  rule_forced: number;
  unscored: number;
  exit_code: number;
  help: string[];
}

/**
 * One "now" per fixture, shared by the commits and by the register rows.
 *
 * Reading the clock twice is what makes a fixture flaky here: a merge time
 * stamped a fraction of a second after the commit it describes turns an elapsed
 * of exactly two days into one of two days minus a moment, and the assertion
 * about how much of the window was used fails on whichever run crosses a
 * second boundary.
 */
function fixtureClock(): { at: (daysAgo: number) => number; iso: (daysAgo: number) => string } {
  const now = Math.floor(Date.now() / 1000);
  const at = (daysAgo: number): number => now - daysAgo * DAY;
  return { at, iso: (daysAgo) => new Date(at(daysAgo) * 1000).toISOString() };
}

function record(over: Partial<LedgerRecord> & Pick<LedgerRecord, 'pr'>): LedgerRecord {
  return {
    v: LEDGER_VERSION,
    recorded_at: Math.floor(Date.now() / 1000),
    repo: 'repo-id',
    repo_slug: 'acme/widgets',
    pr_url: null,
    pr_title: null,
    base_branch: 'main',
    merge_sha: null,
    merge_subject: null,
    merge_parent_sha: null,
    merge_parents: 1,
    head_sha: null,
    merged_at: Math.floor(Date.now() / 1000) - 30 * DAY,
    link: { agreement: 'agrees', git_merge_sha: null, github_merge_sha: null, sentence: '' },
    check_id: 'check',
    check_source: 'merge-commit',
    check_base_sha: 'b'.repeat(40),
    check_head_sha: 'h'.repeat(40),
    score: 20,
    score_max: 120,
    band: 'auto',
    band_from: 'score',
    unverified: false,
    hard_rules: [],
    hits_fingerprint: 'none',
    decision: null,
    gate: 'none',
    drift: null,
    drift_intent: null,
    intent: null,
    config_sha: null,
    eyes_on_version: '0.0.0-test',
    ...over,
  };
}

/**
 * A repository whose history is squash merges and one later fix.
 *
 * `#7` lands the widget; a fix two days later rewrites the lines that merge
 * introduced, so blame on the fix's parent names the merge commit. `#8` lands a
 * gadget nothing ever fixes, so the two channels can differ.
 */
function leakyRepo(prefix: string): {
  repo: TempRepo;
  widget: string;
  gadget: string;
  fix: string;
  /** Seconds since the epoch, `days` ago - the same clock the commits used. */
  at: (days: number) => number;
} {
  const clock = fixtureClock();
  const repo = tempRepo(prefix);
  repo.commitFiles('chore: set up', { 'src/a.ts': 'export const a = 1;\n' }, clock.iso(60));
  const widget = repo.commitFiles(
    'feat(widget): add the widget (#7)',
    { 'src/widget.ts': 'export function widget(): number {\n  return 1;\n}\n' },
    clock.iso(40),
  );
  const gadget = repo.commitFiles(
    'feat(gadget): add the gadget (#8)',
    { 'src/gadget.ts': 'export function gadget(): number {\n  return 2;\n}\n' },
    clock.iso(39),
  );
  const fix = repo.commitFiles(
    'fix(widget): the widget returned the wrong number',
    { 'src/widget.ts': 'export function widget(): number {\n  return 42;\n}\n' },
    clock.iso(38),
  );
  return { repo, widget, gadget, fix, at: clock.at };
}

async function initRepo(t: TestContext, repo: TempRepo, env: Record<string, string>): Promise<void> {
  await captureCli(['init'], { cwd: repo.path, env });
  t.after(async () => {
    await captureCli(['daemon', 'stop'], { cwd: repo.path, env });
  });
}

/**
 * Writes a register for this repository.
 *
 * The id comes from `repoID` - the product's own function, over the same
 * canonical path every command resolves - rather than from a constant, so the
 * fixture cannot come to disagree with eyes-on about which repository these
 * rows belong to.
 */
function writeLedger(repo: TempRepo, env: Record<string, string>, records: (repoId: string) => LedgerRecord[]): void {
  const repoId = repoID(canonicalPath(repo.path));
  mkdirSync(env.EYES_HOME as string, { recursive: true });
  writeFileSync(
    join(env.EYES_HOME as string, 'ledger.jsonl'),
    `${records(repoId).map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
}

/* ------------------------------------------------------------------ *
 * Methodology.
 * ------------------------------------------------------------------ */

/**
 * The acceptance condition is that the file-level variant is **unavailable from
 * the CLI**. Ignoring a flag would satisfy the letter of that and fail its
 * point: a caller who passed it would believe they got what they asked for. So
 * the flag names are recognised and refused, and the refusal carries the base
 * rate that is the reason.
 */
test('acceptance: the file-level variant is unavailable from the CLI, and asking for it is refused by name', async (t) => {
  const { repo } = leakyRepo('leaks-variant');
  const env = sandboxEnv('leaks-variant');
  await initRepo(t, repo, env);

  for (const flag of ['--file-level', '--files', '--file']) {
    const result = await captureCli(['leaks', flag, '--format', 'json'], { cwd: repo.path, env });
    assert.equal(result.code, EXIT_USAGE, `${flag} must be refused rather than ignored`);
    const failure = JSON.parse(result.out) as { error: string; help: string[] };
    assert.match(failure.error, /line-level variant only/);
    assert.ok(
      failure.help.some((line) => line.includes('45-73%')),
      'the reason the variant does not exist is a measured base rate, and the refusal carries it',
    );
  }
  // `--variant` takes a value, so it is refused whatever value is offered -
  // including the one that names the variant that does exist.
  for (const argv of [['leaks', '--variant', 'file'], ['leaks', '--variant', 'line']]) {
    const result = await captureCli([...argv, '--format', 'json'], { cwd: repo.path, env });
    assert.equal(result.code, EXIT_USAGE);
  }

  // And there is no flag on the surface that offers a choice at all.
  const usage = COMMANDS.find((command) => command.name === 'leaks')?.usage ?? '';
  assert.ok(!/variant|file/i.test(usage), `the documented surface offers a variant: ${usage}`);
});

test('acceptance: a leak is decided by blame, and the window decides whether it counts', async (t) => {
  const { repo, widget, gadget, at } = leakyRepo('leaks-blame');
  const env = sandboxEnv('leaks-blame');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({
      repo: repoId,
      pr: 7,
      merge_sha: widget,
      band: 'auto',
      merged_at: at(40),
    }),
    record({
      repo: repoId,
      pr: 8,
      merge_sha: gadget,
      band: 'wskazane',
      merged_at: at(39),
    }),
  ]);

  const result = await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as LeaksDoc;

  assert.equal(result.code, EXIT_OK);
  assert.equal(doc.variant, 'line', 'there is one variant and every payload names it');
  assert.equal(doc.merges, 2);
  assert.equal(doc.leaked, 1);
  assert.equal(doc.leaks.length, 1);
  assert.equal(doc.leaks[0]?.pr, 7, 'the fix rewrote lines the #7 merge introduced, and blame says so');
  assert.equal(doc.leaks[0]?.merge, widget.slice(0, 12));
  assert.ok((doc.leaks[0]?.blamed_lines ?? 0) > 0);
  assert.equal(doc.leaks[0]?.days_after_merge, 2);

  const auto = doc.channels.find((channel) => channel.band === 'auto');
  const indicated = doc.channels.find((channel) => channel.band === 'wskazane');
  assert.deepEqual([auto?.merges, auto?.leaked], [1, 1]);
  assert.deepEqual([indicated?.merges, indicated?.leaked], [1, 0], 'nothing ever fixed the gadget');

  // The same register with a window shorter than the gap counts nothing: the
  // fix is still there, and it is no longer inside the period being reported.
  const narrow = await captureCli(['leaks', '--window', '1d', '--format', 'json'], { cwd: repo.path, env });
  const narrowDoc = JSON.parse(narrow.out) as LeaksDoc;
  assert.equal(narrow.code, EXIT_OK);
  assert.equal(narrowDoc.leaked, 0);
  assert.equal(narrowDoc.window, '1d');
});

test('a true merge commit is left out of the denominator rather than counted clean', async (t) => {
  const repo = tempRepo('leaks-merge');
  const clock = fixtureClock();
  repo.commitFiles('chore: set up', { 'src/a.ts': 'export const a = 1;\n' }, clock.iso(60));
  repo.git(['checkout', '-q', '-b', 'side']);
  repo.commitFiles('feat: the widget', { 'src/widget.ts': 'export const w = 1;\n' }, clock.iso(50));
  repo.git(['checkout', '-q', 'main']);
  repo.git(['merge', '--no-ff', '-q', '-m', 'feat: land the widget (#9)', 'side']);
  const merge = repo.git(['rev-parse', 'HEAD']).trim();

  const env = sandboxEnv('leaks-merge');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 9, merge_sha: merge, merge_parents: 2, band: 'auto' }),
  ]);

  const result = await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as LeaksDoc;

  assert.equal(doc.merges, 0, 'a merge blame can never name is not a merge that stayed clean');
  assert.deepEqual(doc.excluded, [
    { pr: 9, merge: merge.slice(0, 12), reason: 'merge commit introduces no line' },
  ]);
  assert.ok(
    doc.help.some((line) => line.includes('blame never names a merge commit as introducing a line')),
    'the exclusion is explained where the numbers are read',
  );
});

/* ------------------------------------------------------------------ *
 * Honesty.
 * ------------------------------------------------------------------ */

test('acceptance: below a hundred merges in a channel the header says the numbers are directional', () => {
  const short = sampleVerdict([
    { band: 'auto', merges: 55 },
    { band: 'wskazane', merges: 12 },
  ]);
  assert.equal(short.decisive, false);
  assert.match(short.sentence, /directional, not decisive/);
  assert.match(short.sentence, new RegExp(String(MIN_MERGES_PER_CHANNEL)));
  assert.match(short.sentence, /base leak rate near 28%/);
  assert.deepEqual(short.short.map((channel) => channel.band), ['wskazane', 'auto']);

  const enough = sampleVerdict([
    { band: 'auto', merges: 140 },
    { band: 'wskazane', merges: 100 },
  ]);
  assert.equal(enough.decisive, true);
  assert.ok(!enough.sentence.includes('directional'));

  // An empty channel is short rather than clean: a rate over no denominator is
  // not a small number, it is no number.
  const empty = sampleVerdict([{ band: 'auto', merges: 200 }, { band: 'pelna', merges: 0 }]);
  assert.equal(empty.decisive, false);
  assert.equal(empty.smallest?.band, 'pelna');

  const nothing = sampleVerdict([]);
  assert.equal(nothing.decisive, false);
  assert.match(nothing.sentence, /eyes-on label --pr <n>/);
});

test('the directional caveat reaches both the machine payload and the human rendering', async (t) => {
  const { repo, widget, at } = leakyRepo('leaks-honest');
  const env = sandboxEnv('leaks-honest');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, band: 'auto', merged_at: at(40) }),
  ]);

  const json = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.equal(json.directional, true);
  assert.match(json.sample_sentence, /directional, not decisive/);
  assert.equal(json.channels[0]?.directional, true, 'the caveat is on the row too, not only in the header');

  const markdown = await captureCli(['leaks', '--format', 'md'], { cwd: repo.path, env });
  assert.match(markdown.out, /directional, not decisive/);
  assert.match(markdown.out, /Line-level variant only/);
});

test('coverage is reported, so a register missing merges cannot read as a complete one', async (t) => {
  const { repo, widget, at } = leakyRepo('leaks-coverage');
  const env = sandboxEnv('leaks-coverage');
  await initRepo(t, repo, env);
  // The branch landed two pull requests; only one of them is registered.
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, band: 'auto', merged_at: at(40) }),
  ]);

  const doc = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.equal(doc.merged_on_branch, 2);
  assert.equal(doc.registered, 1);
  assert.ok(doc.help.some((line) => line.includes('are not in the register')));
});

test('an absent register is said to be absent, and a line this build cannot read is counted rather than fatal', async (t) => {
  const { repo } = leakyRepo('leaks-absent');
  const env = sandboxEnv('leaks-absent');
  await initRepo(t, repo, env);

  const absent = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.equal(absent.exit_code, EXIT_OK);
  assert.equal(absent.ledger_absent, true);
  assert.equal(absent.merges, 0);
  assert.ok(absent.help.some((line) => line.includes('run `eyes-on label --pr <n>`')));

  writeFileSync(
    join(env.EYES_HOME as string, 'ledger.jsonl'),
    `${JSON.stringify({ v: 999, repo: 'x', pr: 1 })}\nnot json at all\n`,
  );
  const skipped = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.equal(skipped.ledger_lines_skipped, 2, 'an append-only register survives a line a later version wrote');
  assert.equal(skipped.exit_code, EXIT_OK);
});

/* ------------------------------------------------------------------ *
 * Non-blocking, and the flags.
 * ------------------------------------------------------------------ */

test('acceptance: leaks and calibrate exit 0 whatever the numbers are, and neither takes --strict', async (t) => {
  const { repo, widget, at } = leakyRepo('leaks-exit');
  const env = sandboxEnv('leaks-exit');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, band: 'auto', merged_at: at(40) }),
  ]);

  for (const argv of [['leaks'], ['leaks', '--strict'], ['calibrate'], ['calibrate', '--strict']]) {
    const result = await captureCli([...argv, '--format', 'json'], { cwd: repo.path, env });
    assert.equal(result.code, EXIT_OK, `${argv.join(' ')} must not block anything`);
  }
  for (const name of ['leaks', 'calibrate']) {
    assert.ok(!(COMMANDS.find((command) => command.name === name)?.usage ?? '').includes('--strict'));
  }
});

/**
 * The same declaration `NUMERIC_FLAGS` is, against a sharper edge:
 * `Number.parseInt('14d')` is 14 and throws nothing away visibly, so a caller
 * reading `--window` as a string would silently get days whatever was written.
 */
test('a duration flag can only be read with its unit, and reading one as a string is refused', () => {
  assert.deepEqual([...DURATION_FLAGS].sort(), ['since', 'window']);
  for (const name of DURATION_FLAGS) {
    assert.throws(() => flagString(parseArgs([]), name), /duration flag/, `--${name} is still readable as a string`);
  }

  const spec = { what: 'a length of time', help: ['Pass 14d'] };
  const read = (token: string): number | null => flagDuration(parseArgs(['leaks', '--window', token]), 'window', spec);
  assert.equal(read('14d'), 14 * DAY);
  assert.equal(read('2w'), 14 * DAY);
  assert.equal(read('36h'), 36 * 3_600);
  assert.equal(flagDuration(parseArgs(['leaks']), 'window', spec), null);
  // A bare number is refused rather than read as days: the two flags this
  // serves default to different spans, so a unitless number would answer over
  // a period the header names correctly and the caller did not intend.
  for (const token of ['14', '14 days', 'd', '14dd', '0d', '1e9d', '']) {
    assert.throws(() => read(token), /is not a length of time/, `--window ${token} was accepted`);
  }
  // A value that begins with a dash never reaches the duration reader at all:
  // the parser refuses it as a flag with no value, which is the same refusal
  // every other value flag gives and the same remedy.
  assert.throws(() => parseArgs(['leaks', '--window', '-3d']), /flag --window needs a value/);
});

/* ------------------------------------------------------------------ *
 * The sweep.
 * ------------------------------------------------------------------ */

test('the sweep re-bands recorded scores, and never moves a change a hard rule decided', () => {
  const leaks: Leak[] = [
    {
      pr: 1,
      merge_sha: 'm1',
      band: 'auto',
      merged_at: 0,
      fix_sha: 'f1',
      fix_subject: 'fix: it',
      fix_at: DAY,
      days_after_merge: 1,
      blamed_lines: 3,
    },
  ];
  const records = [
    // Low score, leaked. A threshold above it sends it to a human.
    record({ pr: 1, merge_sha: 'm1', score: 20, band: 'auto' }),
    record({ pr: 2, merge_sha: 'm2', score: 20, band: 'auto' }),
    record({ pr: 3, merge_sha: 'm3', score: 80, band: 'pelna' }),
    // Forced to `pelna` by a rule: no threshold on the grid moves it.
    record({ pr: 4, merge_sha: 'm4', score: 5, band: 'pelna', band_from: 'hard rule' }),
  ];

  const report = calibrate({ records, leaks, current: { read_fragments: 35, full_review: 65 }, scoreMax: 120 });

  assert.equal(report.merges, 4);
  assert.equal(report.leaked, 1);
  assert.equal(report.rule_forced, 1);
  // At the thresholds in force, the two 20s and nothing else are automatic:
  // the rule-forced change is `pelna` however low it scored.
  assert.equal(report.current?.auto_merges, 2);
  assert.equal(report.current?.auto_leaked, 1);
  for (const row of report.rows) {
    const pelna = row.channels.find((channel) => channel.band === 'pelna');
    assert.ok((pelna?.merges ?? 0) >= 1, `a rule-forced change left \`pelna\` at ${row.read_fragments}/${row.full_review}`);
  }
});

/**
 * The objective reads two numbers - what `auto` leaks and how much reading is
 * paid - and neither can tell `wskazane` from `pelna`. So a pair that only
 * moves the boundary between the two reading channels scores exactly what the
 * pair in force scores, and is not a different answer.
 *
 * This is the defect the reference register found: beside a current 35/65 the
 * sweep named 35/120 as its candidate - identical on both numbers, and an
 * instruction to abolish the full-review channel for no measured gain.
 */
test('a pair that ties with the one in force is not a candidate, however the grid is ordered', () => {
  const leaks: Leak[] = [
    {
      pr: 1,
      merge_sha: 'm1',
      band: 'auto',
      merged_at: 0,
      fix_sha: 'f1',
      fix_subject: 'fix: it',
      fix_at: DAY,
      days_after_merge: 1,
      blamed_lines: 3,
    },
  ];
  // Every change scores the same, so no threshold splits them: every pair
  // above 20 puts all three in `auto` and pays no reading, exactly as the pair
  // in force does.
  const records = [
    record({ pr: 1, merge_sha: 'm1', score: 20 }),
    record({ pr: 2, merge_sha: 'm2', score: 20 }),
    record({ pr: 3, merge_sha: 'm3', score: 20 }),
  ];
  const report = calibrate({ records, leaks, current: { read_fragments: 35, full_review: 65 }, scoreMax: 120 });

  assert.equal(report.candidate, null, `the sweep named ${JSON.stringify(report.candidate)} as a candidate`);
  assert.match(report.candidate_blocked ?? '', /argues for no change/);
  assert.match(report.candidate_blocked ?? '', /cannot tell `wskazane` from `pelna`/);
  // Every row that ties on the objective is still in the grid - the sweep does
  // not hide them, it declines to call one of them an answer.
  const tied = report.rows.filter(
    (row) => row.auto_merges === report.current?.auto_merges && row.auto_leaked === report.current.auto_leaked,
  );
  assert.ok(tied.length > 1, 'the grid should contain several pairs tied with the one in force');
});

test('a pair that genuinely beats the one in force is named, and it is the smallest such move', () => {
  const leak = (pr: number, merge: string): Leak => ({
    pr,
    merge_sha: merge,
    band: 'auto',
    merged_at: 0,
    fix_sha: `f${pr}`,
    fix_subject: 'fix: it',
    fix_at: DAY,
    days_after_merge: 1,
    blamed_lines: 1,
  });
  // The only change that leaked scores 90, so the automatic channel is clean at
  // the thresholds in force and raising the reading threshold as far as 45
  // sweeps three quiet changes into it without taking that leak along. Past 90
  // it would, and those pairs are refused.
  const records = [
    record({ pr: 1, merge_sha: 'm1', score: 10 }),
    record({ pr: 2, merge_sha: 'm2', score: 12 }),
    record({ pr: 3, merge_sha: 'm3', score: 40 }),
    record({ pr: 4, merge_sha: 'm4', score: 42 }),
    record({ pr: 5, merge_sha: 'm5', score: 44 }),
    record({ pr: 6, merge_sha: 'm6', score: 90 }),
  ];
  const report = calibrate({
    records,
    leaks: [leak(6, 'm6')],
    current: { read_fragments: 35, full_review: 65 },
    scoreMax: 120,
  });

  assert.ok(report.candidate, report.candidate_blocked ?? 'no candidate and no reason given');
  const candidate = report.candidate as NonNullable<typeof report.candidate>;
  assert.ok(candidate.read_share < (report.current?.read_share ?? 0), 'a candidate has to send less to a human');
  assert.ok((candidate.auto_rate ?? 1) <= (report.current?.auto_rate ?? 0), 'and cost no more in the auto channel');
  // The smallest move from 35/65 that reaches the best read share on the grid:
  // an arbitrary tie-break would have named one of the many pairs that reach it
  // from the far end.
  assert.deepEqual([candidate.read_fragments, candidate.full_review], [45, 65]);
});

test('a register in which nothing leaked argues for no threshold, and says so instead of ranking a tie', () => {
  const report = calibrate({
    records: [record({ pr: 1, merge_sha: 'm1', score: 20 }), record({ pr: 2, merge_sha: 'm2', score: 90, band: 'pelna' })],
    leaks: [],
    current: { read_fragments: 35, full_review: 65 },
    scoreMax: 120,
  });
  assert.equal(report.candidate, null);
  assert.match(report.candidate_blocked ?? '', /every pair of thresholds costs the same on this evidence/);
});

test('a score computed under different weights is set aside rather than compared with a threshold', () => {
  const report = calibrate({
    records: [
      record({ pr: 1, merge_sha: 'm1', score: 20, score_max: 120 }),
      // Recorded at stage 1, before drift was scored: 60 out of 100 is a
      // different number from 60 out of 120 and no threshold means both.
      record({ pr: 2, merge_sha: 'm2', score: 60, score_max: 100 }),
      record({ pr: 3, merge_sha: 'm3', score: 60, score_max: null }),
    ],
    leaks: [],
    current: { read_fragments: 35, full_review: 65 },
    scoreMax: 120,
  });
  assert.equal(report.merges, 1);
  assert.deepEqual(report.other_scales, [
    { score_max: null, merges: 1 },
    { score_max: 100, merges: 1 },
  ]);
});

test('calibrate reports the sweep, writes nothing, and names what it could not include', async (t) => {
  const { repo, widget, gadget, at } = leakyRepo('calibrate-cli');
  const env = sandboxEnv('calibrate-cli');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, score: 20, band: 'auto', merged_at: at(40) }),
    record({ repo: repoId, pr: 8, merge_sha: gadget, score: 90, band: 'pelna', merged_at: at(39) }),
  ]);

  const result = await captureCli(['calibrate', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as CalibrateDoc;

  assert.equal(result.code, EXIT_OK);
  assert.equal(doc.merges, 2);
  assert.equal(doc.score_max, 120);
  assert.equal(doc.current_read_fragments, 35);
  assert.equal(doc.current_full_review, 65);
  assert.ok(doc.rows_considered > 100, 'a grid at a step of five over a maximum of 120 is a few hundred pairs');
  assert.equal(doc.directional, true);
  assert.ok(
    doc.help.some((line) => line.includes('eyes-on reads and never writes')),
    'the thresholds live on the default branch, and calibrate says it will not write them',
  );

  const markdown = await captureCli(['calibrate', '--format', 'md'], { cwd: repo.path, env });
  assert.match(markdown.out, /read \/ full/);
  assert.match(markdown.out, /directional, not decisive/);
});

/* ------------------------------------------------------------------ *
 * The two halves meet.
 * ------------------------------------------------------------------ */

test('a register written by label is the register leaks reads', async (t) => {
  const { repo, widget } = leakyRepo('leaks-endtoend');
  const env = sandboxEnv('leaks-endtoend');
  await initRepo(t, repo, env);

  const parent = repo.git(['rev-parse', `${widget}^`]).trim();
  await captureCli(['check', '--base', parent, '--head', widget, '--format', 'json'], { cwd: repo.path, env });

  // No gh on PATH: the chain is reconstructed from the `(#7)` subject alone,
  // and the merge time falls back to when the commit landed on the branch.
  const labelled = await captureCli(['label', '--pr', '7', '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, PATH: pathWithGitOnly('leaks-endtoend-path') },
  });
  assert.equal(labelled.code, EXIT_OK);
  assert.equal((JSON.parse(labelled.out) as { link: string }).link, 'git-only');

  const doc = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.equal(doc.merges, 1);
  assert.equal(doc.leaked, 1);
  assert.equal(doc.leaks[0]?.pr, 7);
  assert.equal(doc.registered, 1);
});
