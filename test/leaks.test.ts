import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureCli, pathWithGitOnly, run, sandboxEnv, tempRepo, type TempRepo } from './helpers.js';
import { EXIT_OK, EXIT_USAGE } from '../src/cli/output.js';
import { LEDGER_VERSION, type LedgerRecord } from '../src/ledger/ledger.js';
import { calibrate } from '../src/ledger/calibrate.js';
import { sampleVerdict, MIN_MERGES_PER_CHANNEL } from '../src/ledger/sample.js';
import { flagDuration, flagString, parseArgs, DURATION_FLAGS } from '../src/cli/args.js';
import { COMMANDS } from '../src/cli/commands.js';
import type { Leak } from '../src/ledger/leaks.js';
import { canonicalPath, repoID } from '../src/core/repoid.js';
import { RepoReader } from '../src/git/reader.js';

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
  excluded: { pr: number; merge: string | null; reason: string; permanent: boolean }[];
  register_rows: number;
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
  ledger_lines_skipped: number;
  outside_denominator: { reason: string; merges: number }[];
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
    link: { agreement: 'agrees', git_merge_sha: null, github_merge_sha: null, git_candidates: 1, sentence: '' },
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
    { pr: 9, merge: merge.slice(0, 12), reason: 'merge commit introduces no line', permanent: true },
  ]);
  assert.ok(
    doc.help.some((line) => line.includes('blame never names a merge commit as introducing a line')),
    'the exclusion is explained where the numbers are read',
  );
  // Every registered row is out for good, so the header says that - without
  // telling a `leaks` reader to run `eyes-on leaks`.
  assert.match(doc.sample_sentence, /Nothing here is measurable yet/);
  assert.match(doc.sample_sentence, /Waiting admits none of them/);
  assert.ok(
    !doc.sample_sentence.includes('run `eyes-on leaks`'),
    `the sentence is printed by leaks itself: ${doc.sample_sentence}`,
  );
});


/**
 * Both ends of the window are landing times.
 *
 * A branch written before the change it fixes, rebased onto it and landed
 * afterwards keeps its author date, which is earlier than the merge it blames
 * into. Read as the fix time that is a negative elapsed, and a real leak
 * disappears under a comment about a clock disagreeing with itself.
 */
test('the leak window is measured between two landing times, so a rebased fix is not dropped for predating its merge', async (t) => {
  const clock = fixtureClock();
  const repo = tempRepo('leaks-clock');
  repo.commitFiles('chore: set up', { 'src/a.ts': 'export const a = 1;\n' }, clock.iso(60));
  const widget = repo.commitFiles(
    'feat(widget): add the widget (#7)',
    { 'src/widget.ts': 'export function widget(): number {\n  return 1;\n}\n' },
    clock.iso(40),
  );
  repo.commitFiles(
    'fix(widget): the widget returned the wrong number',
    { 'src/widget.ts': 'export function widget(): number {\n  return 42;\n}\n' },
    clock.iso(50),
  );
  // Written ten days before the merge, landed five days after it.
  run(repo.path, ['commit', '--amend', '--no-edit', '--quiet'], {
    GIT_AUTHOR_DATE: clock.iso(50),
    GIT_COMMITTER_DATE: clock.iso(35),
  });
  const fix = repo.git(['rev-parse', 'HEAD']).trim();
  assert.ok(
    Number(repo.git(['show', '-s', '--format=%at', fix]).trim()) < clock.at(40),
    'the fixture is only about anything if the fix was authored before the merge it blames into',
  );

  const env = sandboxEnv('leaks-clock');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, band: 'auto', merged_at: clock.at(40) }),
  ]);

  const doc = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.equal(doc.merges, 1);
  assert.equal(doc.leaked, 1, 'the fix landed five days after the merge, and that is what the window measures');
  assert.equal(doc.leaks[0]?.fix, fix.slice(0, 12));
  assert.equal(doc.leaks[0]?.days_after_merge, 5);
});

/**
 * The other end of the denominator, and the same argument the header makes
 * about a true merge commit: a merge that has had four hours of its fourteen
 * days has not been observed for as long as the rest of the table, and counting
 * it as clean divides the leaks by merges that were never given the chance.
 */
test('a merge whose window has not elapsed leaves the denominator with the reason recorded', async (t) => {
  const { repo, widget, gadget, at } = leakyRepo('leaks-window');
  const env = sandboxEnv('leaks-window');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, band: 'auto', merged_at: at(40) }),
    // Landed yesterday: one day of the fourteen it would be measured over.
    record({ repo: repoId, pr: 8, merge_sha: gadget, band: 'wskazane', merged_at: at(1) }),
  ]);

  const doc = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.equal(doc.merges, 1, 'a merge that has not had its window is under-observed, not clean');
  assert.deepEqual(doc.excluded, [
    { pr: 8, merge: gadget.slice(0, 12), reason: 'window has not elapsed', permanent: false },
  ]);
  assert.ok(
    doc.channels.every((channel) => channel.band !== 'wskazane'),
    'and it is in no channel row either, so no rate is computed over it',
  );
  assert.ok(
    doc.help.some(
      (line) => line.includes('not passed yet') && line.includes('the denominator takes it back once 14d has passed'),
    ),
    `the one reason time undoes says so, with the window it waits for: ${JSON.stringify(doc.help)}`,
  );

  // The same register measured over a window it has had counts it again: the
  // exclusion is about elapsed time, not about the row.
  const short = JSON.parse(
    (await captureCli(['leaks', '--window', '12h', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as LeaksDoc;
  assert.equal(short.merges, 2);
  assert.deepEqual(short.excluded, []);
});

/**
 * One measuring instrument, not two.
 *
 * `calibrate` divides its leak counts by a population, and that population has
 * to be the one `leaks` divided by - otherwise every rate on the grid is
 * diluted by merges no leak could ever have been attributed to, and the two
 * commands print different channel sizes for one register.
 */
test('the sweep runs over exactly the merges the leak measurement put in its denominator', async (t) => {
  const { repo, widget, gadget, at } = leakyRepo('calibrate-population');
  const env = sandboxEnv('calibrate-population');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, score: 20, band: 'auto', merged_at: at(40) }),
    // Merged well outside the default --since, so no fix inside the reported
    // range can ever be attributed to it.
    record({ repo: repoId, pr: 8, merge_sha: gadget, score: 90, band: 'pelna', merged_at: at(200) }),
  ]);

  const leaks = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  const sweep = JSON.parse((await captureCli(['calibrate', '--format', 'json'], { cwd: repo.path, env })).out) as CalibrateDoc;

  assert.equal(leaks.merges, 1);
  assert.equal(sweep.merges, leaks.merges, 'two commands reporting different sizes for one register are two instruments');
  assert.deepEqual(sweep.outside_denominator, [{ reason: 'outside --since', merges: 1 }]);
  assert.ok(
    sweep.help.some((line) => line.includes('outside the leak denominator')),
    `the narrowing is reported rather than silent: ${JSON.stringify(sweep.help)}`,
  );
});

/**
 * The walk that finds fix commits reads no diffstat.
 *
 * `--numstat` makes git produce a per-file line count for every commit in the
 * window, and nothing downstream reads it: a fix is recognised from its subject
 * and blamed from its own patch. The same reason `firstParentLog` never asks
 * for one.
 */
test('a history walk can be asked for commits without their per-file line counts', () => {
  const repo = tempRepo('history-nofiles');
  repo.commitFiles('feat: two files', { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' });
  const reader = new RepoReader({ clonePath: repo.path, mirrorPath: join(repo.path, 'no-mirror') });
  const head = reader.resolve('HEAD');
  assert.ok(head);

  const withFiles = reader.history({ until: head });
  const without = reader.history({ until: head, withFiles: false });

  assert.deepEqual(
    without.map((commit) => commit.sha),
    withFiles.map((commit) => commit.sha),
    'the same commits, in the same order',
  );
  assert.deepEqual(
    without.map((commit) => [commit.subject, commit.timestamp, commit.committed, commit.parents]),
    withFiles.map((commit) => [commit.subject, commit.timestamp, commit.committed, commit.parents]),
  );
  assert.ok((withFiles[0]?.files.length ?? 0) >= 2, 'the default still counts lines per file');
  assert.deepEqual(without[0]?.files, [], 'and the cheap walk asks git for none of it');
});


/**
 * The parent count is one rule asked of whichever source can answer it.
 *
 * A row GitHub alone placed carries none: no default-branch subject named that
 * commit, which is every row on a repository that merges with `--no-ff` - the
 * repository this exclusion exists for. Reading it from the object store there
 * keeps one predicate and repairs rows written before it.
 */
test('a true merge commit is excluded even when the register row carries no parent count', async (t) => {
  const repo = tempRepo('leaks-noparents');
  const clock = fixtureClock();
  repo.commitFiles('chore: set up', { 'src/a.ts': 'export const a = 1;\n' }, clock.iso(60));
  repo.git(['checkout', '-q', '-b', 'side']);
  repo.commitFiles('feat: the widget', { 'src/widget.ts': 'export const w = 1;\n' }, clock.iso(50));
  repo.git(['checkout', '-q', 'main']);
  // No `(#N)` in the subject: git names no candidate, so a real `label` run
  // over this pull request records GitHub's merge commit and no parent count.
  repo.git(['merge', '--no-ff', '-q', '-m', 'Merge pull request from side', 'side']);
  const merge = repo.git(['rev-parse', 'HEAD']).trim();

  const env = sandboxEnv('leaks-noparents');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 9, merge_sha: merge, merge_parents: null, band: 'auto', merged_at: clock.at(30) }),
  ]);

  const doc = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.equal(doc.merges, 0, 'blame can never name this commit, whichever source told eyes-on about it');
  assert.deepEqual(doc.excluded, [
    { pr: 9, merge: merge.slice(0, 12), reason: 'merge commit introduces no line', permanent: true },
  ]);
});

/**
 * A structural exclusion dressed as a temporary one is a message stronger than
 * the code: the window help line promises the row returns once the window has
 * passed, and for a commit blame can never name, or one this object store does
 * not hold, it never does.
 */
test('a merge that is both inside its window and structurally excluded is reported under the permanent reason', async (t) => {
  const repo = tempRepo('leaks-order');
  const clock = fixtureClock();
  repo.commitFiles('chore: set up', { 'src/a.ts': 'export const a = 1;\n' }, clock.iso(60));
  repo.git(['checkout', '-q', '-b', 'side']);
  repo.commitFiles('feat: the widget', { 'src/widget.ts': 'export const w = 1;\n' }, clock.iso(50));
  repo.git(['checkout', '-q', 'main']);
  repo.git(['merge', '--no-ff', '-q', '-m', 'feat: land the widget (#9)', 'side']);
  const merge = repo.git(['rev-parse', 'HEAD']).trim();
  const absent = 'c'.repeat(40);

  const env = sandboxEnv('leaks-order');
  await initRepo(t, repo, env);
  // Both landed yesterday, so both are inside the fourteen-day window as well.
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 9, merge_sha: merge, merge_parents: 2, band: 'auto', merged_at: clock.at(1) }),
    record({ repo: repoId, pr: 10, merge_sha: absent, merge_parents: 1, band: 'auto', merged_at: clock.at(1) }),
  ]);

  const doc = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.deepEqual(doc.excluded, [
    { pr: 9, merge: merge.slice(0, 12), reason: 'merge commit introduces no line', permanent: true },
    { pr: 10, merge: absent.slice(0, 12), reason: 'commit not in this repository', permanent: true },
  ]);
  assert.ok(
    doc.help.every((line) => !line.includes('takes them back') && !line.includes('takes it back')),
    `a permanent exclusion may not promise a return: ${JSON.stringify(doc.help)}`,
  );
  // Each reason's own words, including the remedy that really clears it. The
  // true merge commit has none and says so; the absent commit is a fetch away.
  assert.ok(doc.help.some((line) => line.includes('Nothing clears this one')));
  assert.ok(doc.help.some((line) => line.includes('Fetch the default branch into this clone')));
  assert.ok(
    !doc.help.some((line) => line.includes('not passed yet')),
    `neither row comes back once the window passes, so nothing may promise it: ${JSON.stringify(doc.help)}`,
  );
});


/**
 * The ordinary first state of the product, not an edge of it.
 *
 * A team adopts eyes-on, labels its last twenty merges and runs `leaks` the
 * same afternoon. Every row is inside the fourteen-day window, so the
 * denominator is empty - and a header reading "no merge is in the register yet,
 * run `label` after each merge" would be a false sentence at the first moment
 * anybody reads one. The register is full; it is merely too young.
 */
test('a full register whose merges are all too young says so, and does not call itself empty', async (t) => {
  const { repo, widget, gadget, at } = leakyRepo('leaks-young');
  const env = sandboxEnv('leaks-young');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, score: 20, band: 'auto', merged_at: at(1) }),
    record({ repo: repoId, pr: 8, merge_sha: gadget, score: 90, band: 'pelna', merged_at: at(2) }),
  ]);

  const doc = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.equal(doc.merges, 0);
  assert.equal(doc.register_rows, 2, 'the payload carries what the register holds beside what is measurable');
  assert.match(doc.sample_sentence, /Nothing here is measurable yet/);
  assert.match(doc.sample_sentence, /holds 2 merges/);
  assert.match(doc.sample_sentence, /window has passed/, 'these rows come back, and the sentence may say so');
  assert.ok(
    !doc.sample_sentence.includes('run `eyes-on leaks`'),
    `two commands print this sentence, so it may not name one of them: ${doc.sample_sentence}`,
  );
  assert.ok(
    !doc.sample_sentence.includes('run `eyes-on label --pr <n>`'),
    `the reader has just run label twenty times: ${doc.sample_sentence}`,
  );

  // The same register through the other surface says the same thing: the two
  // commands read one helper, so neither can describe this state differently.
  const sweep = JSON.parse(
    (await captureCli(['calibrate', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CalibrateDoc;
  assert.equal(sweep.merges, 0);
  assert.match(sweep.sample_sentence, /Nothing here is measurable yet/);
  assert.ok(!sweep.sample_sentence.includes('run `eyes-on label --pr <n>`'));

  // And a register nobody has written to still gets the sentence that names the
  // command that fills it - the two states stay two.
  const other = sandboxEnv('leaks-young-empty');
  await initRepo(t, repo, other);
  const blank = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env: other })).out) as LeaksDoc;
  assert.equal(blank.register_rows, 0);
  assert.match(blank.sample_sentence, /No channel has a merge in the register yet/);
});

/**
 * Coverage compares pull requests with pull requests.
 *
 * `mergedPulls` keeps a number that landed twice twice and says the caller
 * decides; the register has already been reduced to one row per pull request,
 * so counting commits against rows invents a gap in a register that holds
 * everything.
 */
test('a pull request landed twice is one pull request in the coverage ratio', async (t) => {
  const clock = fixtureClock();
  const repo = tempRepo('leaks-coverage-twice');
  repo.commitFiles('chore: set up', { 'src/a.ts': 'export const a = 1;\n' }, clock.iso(60));
  const widget = repo.commitFiles(
    'feat(widget): add the widget (#7)',
    { 'src/widget.ts': 'export const w = 1;\n' },
    clock.iso(40),
  );
  // Reverted and re-landed under a subject that kept the suffix: two commits on
  // the default branch, one pull request.
  repo.commitFiles(
    'fix(widget): re-land the widget (#7)',
    { 'src/widget.ts': 'export const w = 2;\n' },
    clock.iso(39),
  );

  const env = sandboxEnv('leaks-coverage-twice');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, band: 'auto', merged_at: clock.at(40) }),
  ]);

  const doc = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.equal(doc.merged_on_branch, 1, 'the branch landed one pull request, whatever the commit count');
  assert.equal(doc.registered, 1);
  assert.ok(
    !doc.help.some((line) => line.includes('are not in the register')),
    `the register holds every pull request the branch landed: ${JSON.stringify(doc.help)}`,
  );
});


/**
 * A merge can satisfy several exclusions at once, and the one reported decides
 * what the reader is told to do about it.
 *
 * The ordinary backfill on the repository this exclusion exists for: a change
 * merged two hundred days ago, landed as a true merge commit. It is both
 * outside the range and structurally unattributable, and only the second is
 * still true after the reader takes the advice the first one carries. Advice
 * that is followed and then contradicted is worse than no advice.
 */
test('a merge excluded for several reasons at once is reported under the most binding one', async (t) => {
  const repo = tempRepo('leaks-binding');
  const clock = fixtureClock();
  repo.commitFiles('chore: set up', { 'src/a.ts': 'export const a = 1;\n' }, clock.iso(300));
  repo.git(['checkout', '-q', '-b', 'side']);
  repo.commitFiles('feat: the widget', { 'src/widget.ts': 'export const w = 1;\n' }, clock.iso(250));
  repo.git(['checkout', '-q', 'main']);
  repo.git(['merge', '--no-ff', '-q', '-m', 'feat: land the widget (#9)', 'side']);
  const merge = repo.git(['rev-parse', 'HEAD']).trim();

  const env = sandboxEnv('leaks-binding');
  await initRepo(t, repo, env);
  // Two hundred days ago, so it is outside the default ninety-day range too -
  // and the row carries no parent count, as a row GitHub alone placed does.
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 9, merge_sha: merge, merge_parents: null, band: 'auto', merged_at: clock.at(200) }),
  ]);

  const doc = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.deepEqual(doc.excluded, [
    { pr: 9, merge: merge.slice(0, 12), reason: 'merge commit introduces no line', permanent: true },
  ]);
  assert.ok(
    doc.help.some((line) => line.includes('Nothing clears this one')),
    `the reader is told the truth about this row: ${JSON.stringify(doc.help)}`,
  );
  assert.ok(
    !doc.help.some((line) => line.includes('pass a longer `--since`')),
    `a longer --since reports the same row differently, so it may not be offered: ${JSON.stringify(doc.help)}`,
  );

  // And taking that advice would indeed have contradicted it: the reason does
  // not change when the range widens, which is what makes it the binding one.
  const wider = JSON.parse(
    (await captureCli(['leaks', '--since', '365d', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as LeaksDoc;
  assert.equal(wider.excluded[0]?.reason, 'merge commit introduces no line');
});

/**
 * Coverage compares one population with itself.
 *
 * A branch whose subjects carry no trailing `(#N)` - one that merges with
 * `--no-ff`, or writes "Merge pull request #7 from ..." - lands nothing this
 * walk can count, while the register may be full of rows GitHub placed. A
 * numerator has no right to exceed its denominator: if it can, two different
 * populations are being counted under one sentence.
 */
test('a branch whose subjects name no pull request reports no coverage ratio rather than an impossible one', async (t) => {
  const repo = tempRepo('leaks-nocoverage');
  const clock = fixtureClock();
  repo.commitFiles('chore: set up', { 'src/a.ts': 'export const a = 1;\n' }, clock.iso(60));
  // GitHub's other merge-subject shape: the number is there, but not as the
  // trailing `(#N)` a squash merge leaves, so nothing on the branch is counted.
  const landed = repo.commitFiles(
    'Merge pull request #7 from acme/widget',
    { 'src/widget.ts': 'export const w = 1;\n' },
    clock.iso(40),
  );

  const env = sandboxEnv('leaks-nocoverage');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: landed, band: 'auto', merged_at: clock.at(40) }),
  ]);

  const doc = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.equal(doc.merged_on_branch, 0);
  assert.ok(doc.registered <= doc.merged_on_branch, `a numerator above its denominator: ${doc.registered}/${doc.merged_on_branch}`);
  assert.equal(doc.register_rows, 1, 'the rows are still there and still counted');
  assert.ok(
    doc.help.some((line) => line.includes('nothing to measure coverage against')),
    `the state is named rather than divided by: ${JSON.stringify(doc.help)}`,
  );

  const markdown = await captureCli(['leaks', '--format', 'md'], { cwd: repo.path, env });
  assert.ok(
    !/of the 0 pull requests/.test(markdown.out),
    `a ratio over nothing is not a small number, it is no number: ${markdown.out}`,
  );
  assert.match(markdown.out, /nothing to measure against/);
});

/* ------------------------------------------------------------------ *
 * Honesty.
 * ------------------------------------------------------------------ */

test('acceptance: below a hundred merges in a channel the header says the numbers are directional', () => {
  const measured = { registered: 67, measurable: 67, excluded: [] };
  const short = sampleVerdict(
    [
      { band: 'auto', merges: 55 },
      { band: 'wskazane', merges: 12 },
    ],
    measured,
    'measured',
  );
  assert.equal(short.decisive, false);
  assert.match(short.sentence, /directional, not decisive/);
  assert.match(short.sentence, new RegExp(String(MIN_MERGES_PER_CHANNEL)));
  assert.match(short.sentence, /base leak rate near 28%/);
  assert.deepEqual(short.short.map((channel) => channel.band), ['wskazane', 'auto']);

  const enough = sampleVerdict(
    [
      { band: 'auto', merges: 140 },
      { band: 'wskazane', merges: 100 },
    ],
    { registered: 240, measurable: 240, excluded: [] },
    'measured',
  );
  assert.equal(enough.decisive, true);
  assert.ok(!enough.sentence.includes('directional'));

  // An empty channel is short rather than clean: a rate over no denominator is
  // not a small number, it is no number.
  const empty = sampleVerdict(
    [
      { band: 'auto', merges: 200 },
      { band: 'pelna', merges: 0 },
    ],
    { registered: 200, measurable: 200, excluded: [] },
    'projected',
  );
  assert.equal(empty.decisive, false);
  assert.equal(empty.smallest?.band, 'pelna');

  const nothing = sampleVerdict([], { registered: 0, measurable: 0, excluded: [] }, 'measured');
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


/**
 * Two commands, one register, two questions - and each header says which.
 *
 * `leaks` measures what happened, so a band nothing was ever in is not a
 * measurement of that band. `calibrate` moves thresholds and can move merges
 * into a band that is empty today, so that band's size is part of its answer.
 * Forcing the two headers to agree would make one of them wrong; naming the
 * population in each makes them two answers instead of a contradiction.
 */
test('the honesty header names the population it is about, so the two commands do not read as contradicting each other', async (t) => {
  const { repo, widget, gadget, at } = leakyRepo('sample-question');
  const env = sandboxEnv('sample-question');
  await initRepo(t, repo, env);
  // Every registered merge is `auto`, so the register has one channel and the
  // thresholds in force produce three.
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, score: 20, band: 'auto', merged_at: at(40) }),
    record({ repo: repoId, pr: 8, merge_sha: gadget, score: 20, band: 'auto', merged_at: at(39) }),
  ]);

  const leaks = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  const sweep = JSON.parse(
    (await captureCli(['calibrate', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CalibrateDoc;

  assert.match(leaks.sample_sentence, /the channels this register has merges in/);
  assert.ok(
    !leaks.sample_sentence.includes('`pelna` 0'),
    `leaks measures what happened, so it names no band nothing was in: ${leaks.sample_sentence}`,
  );

  assert.match(sweep.sample_sentence, /the channels these thresholds would produce/);
  assert.match(sweep.sample_sentence, /`pelna` 0/, 'a band a moved threshold could fill is part of the sweep\'s answer');

  assert.notEqual(
    leaks.sample_sentence,
    sweep.sample_sentence,
    'the two answers differ, and each says which question it answered',
  );
});

/**
 * A label pointing at a number that is not the denominator is a number nobody
 * can use.
 *
 * The rates in the table are divided by the leak denominator; the coverage
 * counts are about which pull requests the branch landed. Both are worth
 * printing and neither is the other.
 */
test('the coverage line names the denominator the rates were divided by, not the coverage count', async (t) => {
  const { repo, widget, gadget, at } = leakyRepo('leaks-coverage-label');
  const env = sandboxEnv('leaks-coverage-label');
  await initRepo(t, repo, env);
  // The branch landed #7 and #8; the register holds both, but #8 landed
  // yesterday, so the denominator is one merge and coverage is two.
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, band: 'auto', merged_at: at(40) }),
    record({ repo: repoId, pr: 8, merge_sha: gadget, band: 'auto', merged_at: at(1) }),
  ]);

  const doc = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  assert.equal(doc.merges, 1);
  assert.equal(doc.registered, 2);
  assert.ok(
    !doc.help.some((line) => line.includes('these rates describe')),
    `nothing may label the coverage count as the denominator: ${JSON.stringify(doc.help)}`,
  );

  // With one pull request uncovered the line prints, and the number it names as
  // the denominator is the one the rates were divided by.
  const partial = sandboxEnv('leaks-coverage-label-partial');
  await initRepo(t, repo, partial);
  writeLedger(repo, partial, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, band: 'auto', merged_at: at(40) }),
  ]);
  const gap = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env: partial })).out) as LeaksDoc;
  const line = gap.help.find((entry) => entry.includes('are not in the register'));
  assert.ok(line, `a register missing a merge still says so: ${JSON.stringify(gap.help)}`);
  assert.match(line, new RegExp(`the rates above are over the ${gap.merges} merge`));
  // Nothing below that line narrows the denominator: the exclusion lines say
  // how it reached that number, and the number is what the channel rows sum to.
  assert.ok(
    !line.includes('narrow further'),
    `the denominator is final, so nothing may suggest it shrinks below: ${line}`,
  );
});

/**
 * An empty branch walk is evidence that coverage cannot be measured, and
 * evidence of nothing else.
 *
 * A repository that squash-merges every pull request but has landed nothing
 * inside `--since` produces exactly the same empty walk as one whose subjects
 * never carry `(#N)`. A sentence about how the register's rows were placed
 * would be false of the first, and only the rows can answer that question.
 */
test('an empty branch walk says coverage cannot be measured and claims nothing about how the rows were placed', async (t) => {
  const { repo, widget, at } = leakyRepo('leaks-noclaim');
  const env = sandboxEnv('leaks-noclaim');
  await initRepo(t, repo, env);
  // The row was placed by a `(#7)` subject on the default branch - but that
  // commit landed forty days ago, and this run reads ten.
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, band: 'auto', merged_at: at(40) }),
  ]);

  const doc = JSON.parse(
    (await captureCli(['leaks', '--since', '10d', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as LeaksDoc;
  assert.equal(doc.merged_on_branch, 0);
  assert.equal(doc.register_rows, 1);
  const line = doc.help.find((entry) => entry.includes('nothing to measure coverage against'));
  assert.ok(line, `the state is still named: ${JSON.stringify(doc.help)}`);
  assert.ok(
    !line.includes('placed by GitHub'),
    `this row was placed by a subject, so nothing may say otherwise: ${line}`,
  );
});

/**
 * A line this build cannot read is counted and reported by every surface that
 * divides by the register, not only by the first one that was taught to.
 */
test('calibrate reports the register lines it could not read, as leaks does for the same file', async (t) => {
  const { repo, widget, at } = leakyRepo('calibrate-skipped');
  const env = sandboxEnv('calibrate-skipped');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, score: 20, band: 'auto', merged_at: at(40) }),
  ]);
  // A line a later version of eyes-on appended: readable as JSON, not as a
  // record of this version.
  writeFileSync(
    join(env.EYES_HOME as string, 'ledger.jsonl'),
    `${readFileSync(join(env.EYES_HOME as string, 'ledger.jsonl'), 'utf8')}${JSON.stringify({ v: 999, repo: 'x', pr: 8 })}
`,
  );

  const leaks = JSON.parse((await captureCli(['leaks', '--format', 'json'], { cwd: repo.path, env })).out) as LeaksDoc;
  const sweep = JSON.parse(
    (await captureCli(['calibrate', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CalibrateDoc;

  assert.equal(leaks.ledger_lines_skipped, 1);
  assert.equal(sweep.ledger_lines_skipped, 1, 'one register, one answer about what it could not read');
  assert.ok(
    sweep.help.some((line) => line.includes('could not be read as a record of this version')),
    `the sweep is short by that row and must say so: ${JSON.stringify(sweep.help)}`,
  );
});

/**
 * The Markdown list of excluded merges renders the reason's own outlook, like
 * every other surface. Writing the promise beside the flag is the construct
 * that let one report state the same fact at two levels of precision.
 */
test('each excluded merge in the Markdown carries the remedy its reason declares', async (t) => {
  const repo = tempRepo('leaks-md-outlook');
  const clock = fixtureClock();
  repo.commitFiles('chore: set up', { 'src/a.ts': 'export const a = 1;\n' }, clock.iso(60));
  repo.git(['checkout', '-q', '-b', 'side']);
  repo.commitFiles('feat: the widget', { 'src/widget.ts': 'export const w = 1;\n' }, clock.iso(50));
  repo.git(['checkout', '-q', 'main']);
  repo.git(['merge', '--no-ff', '-q', '-m', 'feat: land the widget (#9)', 'side']);
  const merge = repo.git(['rev-parse', 'HEAD']).trim();
  const landed = repo.commitFiles(
    'feat(gadget): add the gadget (#10)',
    { 'src/gadget.ts': 'export const g = 1;\n' },
    clock.iso(30),
  );

  const env = sandboxEnv('leaks-md-outlook');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 9, merge_sha: merge, merge_parents: 2, band: 'auto', merged_at: clock.at(30) }),
    record({ repo: repoId, pr: 10, merge_sha: landed, band: 'auto', merged_at: clock.at(1) }),
  ]);

  const markdown = (await captureCli(['leaks', '--format', 'md'], { cwd: repo.path, env })).out;
  const excluded = markdown.slice(markdown.indexOf('## Registered merges outside the denominator'));

  assert.match(excluded, /#9.*Nothing clears this one/s, 'the permanent reason names what it is a property of');
  assert.match(
    excluded,
    /#10.*takes it back once 14d has passed/s,
    'and the one time undoes names the window it waits for, as the help line does',
  );
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


/**
 * A caveat printed twice on one page reads as boilerplate the second time.
 *
 * The acceptance condition is that the report *header* says the numbers are
 * directional, so the header copy is the one that cannot move; the machine
 * payload carries the same sentence as `sample_sentence`, so nothing is lost by
 * saying it once.
 */
test('the honesty header is printed once per report, not again in the help list', async (t) => {
  const { repo, widget, gadget, at } = leakyRepo('sample-once');
  const env = sandboxEnv('sample-once');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, score: 20, band: 'auto', merged_at: at(40) }),
    record({ repo: repoId, pr: 8, merge_sha: gadget, score: 90, band: 'pelna', merged_at: at(39) }),
  ]);

  for (const command of ['leaks', 'calibrate']) {
    const doc = JSON.parse(
      (await captureCli([command, '--format', 'json'], { cwd: repo.path, env })).out,
    ) as { sample_sentence: string; help: string[] };
    assert.ok(doc.sample_sentence.length > 0, `${command} still carries the sentence in its payload`);
    assert.ok(
      !doc.help.includes(doc.sample_sentence),
      `${command} says the caveat once: ${JSON.stringify(doc.help)}`,
    );

    const markdown = (await captureCli([command, '--format', 'md'], { cwd: repo.path, env })).out;
    const occurrences = markdown.split(doc.sample_sentence).length - 1;
    assert.equal(occurrences, 1, `${command} prints the header sentence once, not ${occurrences} times`);
  }
});

/**
 * Advice to widen a range has to name the range it is widening from.
 *
 * `leaks` prints its own `--since` beside the table; the sentence itself now
 * carries it too, so a reader can tell whether a longer span would be enough
 * without matching two numbers across a page.
 */
test('the widen-the-range remedy names the range the row was measured against', async (t) => {
  const { repo, widget, at } = leakyRepo('leaks-since-named');
  const env = sandboxEnv('leaks-since-named');
  await initRepo(t, repo, env);
  writeLedger(repo, env, (repoId) => [
    record({ repo: repoId, pr: 7, merge_sha: widget, band: 'auto', merged_at: at(200) }),
  ]);

  const doc = JSON.parse(
    (await captureCli(['leaks', '--since', '120d', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as LeaksDoc;
  assert.equal(doc.excluded[0]?.reason, 'outside --since');
  const line = doc.help.find((entry) => entry.includes('outside --since'));
  assert.ok(line, `the exclusion is explained: ${JSON.stringify(doc.help)}`);
  assert.match(line, /`--since 120d`/, 'the span this run used is named, not only the advice to widen it');
  assert.match(line, /longer than 120d/);
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

  const report = calibrate({ records, leaks, excluded: [], current: { read_fragments: 35, full_review: 65 }, scoreMax: 120 });

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
  const report = calibrate({ records, leaks, excluded: [], current: { read_fragments: 35, full_review: 65 }, scoreMax: 120 });

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
    excluded: [],
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
    excluded: [],
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
    excluded: [],
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
