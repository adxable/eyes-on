import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stateRoot, tempDir, tempRepo, type TempRepo } from './helpers.js';
import { run as runCli } from '../src/cli/run.js';
import { EXIT_OK, type Writers } from '../src/cli/output.js';
import { RepoReader } from '../src/git/reader.js';
import { backtest, parseSplit, CHURN_DECILE_LIFT_TARGET, FIX_HISTORY_LIFT_TARGET } from '../src/risk/backtest.js';
import { defaultRepoConfig } from '../src/risk/repoconfig.js';

/**
 * The backtest measures whether the signal knew anything. These tests measure
 * whether the backtest does - by building a repository where the answer is
 * known in advance, and one where it is known to be "nothing".
 */

const SPLIT = '2026-03-01';

function readerFor(repo: TempRepo): RepoReader {
  return new RepoReader({ clonePath: repo.path, mirrorPath: join(tempDir('bt-mirror'), 'absent.git') });
}

function config() {
  const base = defaultRepoConfig();
  // The window has to reach back over the pre-split history the tests build.
  base.history_window_days = 60;
  return base;
}

/**
 * Two populations. `src/hot0..2` are fixed before the split and fixed again
 * after it; `src/cold0..17` are written once, before the split, and never
 * touched again. A signal that knows anything must separate them.
 */
function repoWithSignal(): TempRepo {
  const repo = tempRepo('backtest');
  const cold: Record<string, string> = {};
  for (let index = 0; index < 18; index += 1) {
    cold[`src/cold${index}.ts`] = `export const cold${index} = 0;\n`;
  }
  repo.commitFiles('feat: the quiet majority', cold, '2026-01-05T12:00:00Z');

  for (let index = 0; index < 3; index += 1) {
    repo.commitFiles(
      `feat: introduce hot${index}`,
      { [`src/hot${index}.ts`]: 'one\ntwo\nthree\n' },
      '2026-01-10T12:00:00Z',
    );
    repo.commitFiles(
      `fix: correct hot${index} before the split`,
      { [`src/hot${index}.ts`]: 'one\nTWO\nthree\n' },
      '2026-02-10T12:00:00Z',
    );
  }

  for (let index = 0; index < 3; index += 1) {
    repo.commitFiles(
      `fix: correct hot${index} again after the split`,
      { [`src/hot${index}.ts`]: `one\nTWO\nTHREE-${index}\n` },
      '2026-04-10T12:00:00Z',
    );
  }
  return repo;
}

test('a split date must be a real YYYY-MM-DD, not something that parses to anything', () => {
  assert.equal(parseSplit('2026-03-01'), Math.floor(Date.parse('2026-03-01T00:00:00Z') / 1000));
  for (const bad of ['june', '2026-3-1', '01-03-2026', '2026-03']) {
    assert.throws(() => parseSplit(bad), /not YYYY-MM-DD/);
  }
});

test('the signal separates the files that went on to be fixed from the ones that did not', () => {
  const repo = repoWithSignal();
  const reader = readerFor(repo);
  const anchor = reader.resolve('HEAD');
  assert.ok(anchor);

  const [result] = backtest({ reader, db: null, config: config(), anchorSHA: anchor, splits: [SPLIT] });
  assert.ok(result);
  assert.equal(result.note, null);
  assert.equal(result.population, 21, 'every code file that existed at the split is in the denominator');
  assert.equal(result.fix_history.flagged, 3, 'the three files a fix had already blamed into');
  assert.notEqual(result.fix_history.lift, null, 'the fix-history signal was measured on this split');
  assert.ok(
    (result.fix_history.lift ?? 0) >= FIX_HISTORY_LIFT_TARGET,
    `fix-history lift ${String(result.fix_history.lift)} is below the ${FIX_HISTORY_LIFT_TARGET}x the report asks for`,
  );
  assert.notEqual(result.churn_top_decile.lift, null, 'the churn signal was measured on this split');
  assert.ok(
    (result.churn_top_decile.lift ?? 0) >= CHURN_DECILE_LIFT_TARGET,
    `churn top-decile lift ${String(result.churn_top_decile.lift)} is below ${CHURN_DECILE_LIFT_TARGET}x`,
  );
  assert.deepEqual(
    result.fix_history.examples.map((example) => example.path).sort(),
    ['src/hot0.ts', 'src/hot1.ts', 'src/hot2.ts'],
  );
});

test('a repository where nothing predicts anything reports a lift of about one, not a pass', () => {
  const repo = tempRepo('backtest-flat');
  const files: Record<string, string> = {};
  for (let index = 0; index < 10; index += 1) files[`src/f${index}.ts`] = 'one\ntwo\n';
  repo.commitFiles('feat: ten identical files', files, '2026-01-05T12:00:00Z');
  // Every file is fixed exactly once before the split and once after it, so
  // being flagged carries no information at all.
  for (let index = 0; index < 10; index += 1) {
    repo.commitFiles(
      `fix: before, f${index}`,
      { [`src/f${index}.ts`]: 'one\nTWO\n' },
      '2026-02-10T12:00:00Z',
    );
  }
  for (let index = 0; index < 10; index += 1) {
    repo.commitFiles(`fix: after, f${index}`, { [`src/f${index}.ts`]: 'one\nTHREE\n' }, '2026-04-10T12:00:00Z');
  }

  const reader = readerFor(repo);
  const anchor = reader.resolve('HEAD');
  assert.ok(anchor);
  const [result] = backtest({ reader, db: null, config: config(), anchorSHA: anchor, splits: [SPLIT] });
  assert.ok(result);
  assert.equal(result.fix_history.lift, 1, 'flagging everything is the same as flagging nothing');
  assert.ok(result.fix_history.lift < FIX_HISTORY_LIFT_TARGET);
});

test('the signal is built only from before the split and the outcome only from after it', () => {
  const repo = repoWithSignal();
  const reader = readerFor(repo);
  const anchor = reader.resolve('HEAD');
  assert.ok(anchor);
  const [result] = backtest({ reader, db: null, config: config(), anchorSHA: anchor, splits: [SPLIT] });
  assert.ok(result);

  const splitSeconds = parseSplit(SPLIT);
  const before = reader.commit(result.split_commit ?? '');
  assert.ok(before);
  assert.ok(before.timestamp <= splitSeconds, 'the split commit is on the pre-split side');
  assert.equal(result.before_fix_commits, 3, 'three fixes before the split');
  assert.equal(result.after_fix_commits, 3, 'three after it, and none counted twice');
});

test('a split with nothing on one side of it is reported as such, never as a zero result', () => {
  const repo = repoWithSignal();
  const reader = readerFor(repo);
  const anchor = reader.resolve('HEAD');
  assert.ok(anchor);
  const results = backtest({
    reader,
    db: null,
    config: config(),
    anchorSHA: anchor,
    splits: ['2020-01-01', '2030-01-01'],
  });
  assert.match(results[0]?.note ?? '', /no commit on this branch is older than the split date/);
  assert.match(results[1]?.note ?? '', /no commits landed in the outcome window \(after 2030-01-01, up to the branch head\)/);
});

test('the horizon bounds the outcome window when one is asked for', () => {
  const repo = repoWithSignal();
  const reader = readerFor(repo);
  const anchor = reader.resolve('HEAD');
  assert.ok(anchor);
  // The post-split fixes land on 10 April, so a 14-day horizon from 1 March
  // ends before them.
  const [narrow] = backtest({
    reader,
    db: null,
    config: config(),
    anchorSHA: anchor,
    splits: [SPLIT],
    horizonDays: 14,
  });
  assert.equal(narrow?.after_fix_commits, 0);
  // The note names the window it actually looked in, horizon and all, rather
  // than blaming the split date for a bound the caller chose.
  assert.match(narrow?.note ?? '', /no commits landed in the outcome window \(after 2026-03-01, within 14 days\)/);
});

async function cli(argv: string[], options: { cwd: string; env: Record<string, string> }): Promise<{ code: number; out: string }> {
  let out = '';
  const writers: Writers = { out: (chunk) => (out += chunk), err: () => {} };
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  process.chdir(options.cwd);
  delete process.env.NO_MISTAKES_GATE;
  Object.assign(process.env, options.env);
  try {
    const code = await runCli(argv, writers);
    return { code, out };
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

/**
 * A repository that reaches both of the reasons a populated split still cannot
 * be measured: one split has no commits after it at all, and the other has fix
 * commits after it that touch only a file created later.
 */
function repoWithUnmeasurableSplits(): TempRepo {
  const repo = tempRepo('bt-notes');
  repo.commitFiles('feat: the file that exists at the split', { 'src/a.ts': 'one\ntwo\n' }, '2026-01-05T12:00:00Z');
  repo.commitFiles('feat: a file created after the split', { 'src/b.ts': 'one\ntwo\n' }, '2026-04-01T12:00:00Z');
  repo.commitFiles('fix: correct the newer file', { 'src/b.ts': 'one\nTWO\n' }, '2026-04-05T12:00:00Z');
  return repo;
}

test('a split that could not be measured says which signal, and why, in both formats', async () => {
  const repo = repoWithUnmeasurableSplits();
  const env = {
    EYES_HOME: stateRoot(),
    EYES_ON_SKILL_ROOT: tempDir('bt-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NM_HOME: tempDir('bt-nm-home'),
  };

  // 2026-03-01: files existed and fixes landed afterwards, but none of them
  // touched a file that existed at the split - the base rate the lift divides
  // by is zero. 2026-06-01: nothing landed after it at all, so no signal ran.
  const argv = ['backtest', '--split', '2026-03-01,2026-06-01'];
  const result = await cli([...argv, '--format', 'md'], { cwd: repo.path, env });
  assert.equal(result.code, EXIT_OK);

  const json = await cli([...argv, '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(json.out) as {
    evaluated: number;
    not_measured: { split: string; signal: string; reason: string }[];
    results: {
      split: string;
      population: number;
      churn_decile_status: string;
      churn_decile_flagged: number | null;
      fix_history_status: string;
      fix_history_flagged: number | null;
    }[];
  };
  assert.equal(doc.evaluated, 0, 'no signal produced a lift on either split');
  const bySplit = new Map(doc.results.map((entry) => [entry.split, entry]));

  // The base-rate split ran every signal, so its counts are real measurements.
  const baseRateSplit = bySplit.get('2026-03-01');
  assert.equal(baseRateSplit?.churn_decile_status, 'no-lift');
  assert.equal(baseRateSplit?.churn_decile_flagged, 1);
  assert.equal(baseRateSplit?.fix_history_status, 'no-lift');
  assert.equal(baseRateSplit?.fix_history_flagged, 0);
  // The outcome-window split never got as far as flagging anything.
  assert.equal(bySplit.get('2026-06-01')?.fix_history_status, 'not-run');
  assert.equal(bySplit.get('2026-06-01')?.fix_history_flagged, null);

  const reasons = doc.not_measured;
  assert.equal(reasons.filter((entry) => entry.split === '2026-03-01').length, 3, 'all three signals, one reason each');
  for (const entry of reasons.filter((item) => item.split === '2026-03-01')) {
    assert.match(entry.reason, /base rate this lift divides by is zero|averages over an empty set/);
  }
  assert.deepEqual(
    reasons.filter((entry) => entry.split === '2026-06-01'),
    [
      {
        split: '2026-06-01',
        signal: 'every signal',
        reason:
          'no commits landed in the outcome window (after 2026-06-01, up to the branch head): there is no outcome to measure',
      },
    ],
    'a split the replay could not get through says so once, for the split',
  );

  // The Markdown must state the same numbers as the payload, cell by cell, and
  // must not present anything it did not measure as a lift.
  const row = (split: string): string[] => {
    const line = result.out.split('\n').find((entry) => entry.startsWith(`| ${split} `));
    assert.ok(line, `${split} must have a row`);
    return line.split('|').slice(1, -1).map((cell) => cell.trim());
  };
  assert.deepEqual(row('2026-03-01'), ['2026-03-01', '1', '0', 'not measured', '0', 'not measured', '1', 'not measured']);
  assert.deepEqual(row('2026-06-01'), ['2026-06-01', '2', '-', 'not measured', '-', 'not measured', '-', 'not measured']);

  assert.match(result.out, /## What was not measured, and why/);
  assert.match(result.out, /\*\*2026-03-01\*\*, churn top decile: .*base rate this lift divides by is zero/);
  assert.match(result.out, /\*\*2026-06-01\*\*, every signal: .*no outcome to measure/);
});


/**
 * A repository with no fix commit before the split and one after it that
 * touches a file which existed at the split.
 *
 * The fix-history and fix-touch signals flag nothing, so their lift divides
 * over an empty set; the churn signal has a top decile and measures normally.
 * The split is not a failure of the signal - it is a split the signal had
 * nothing to say about.
 */
function repoWithNothingFlagged(): TempRepo {
  const repo = tempRepo('bt-unflagged');
  const files: Record<string, string> = {};
  for (let index = 0; index < 12; index += 1) {
    files[`src/f${index}.ts`] = `export const f${index} = 0;\n`;
  }
  repo.commitFiles('feat: everything, once, before the split', files, '2026-01-10T12:00:00Z');
  repo.commitFiles(
    'fix: correct one of them after the split',
    { 'src/f0.ts': 'export const f0 = 1;\n' },
    '2026-04-10T12:00:00Z',
  );
  return repo;
}

test('a signal that flagged nothing is not measured, and does not count as a failed split', () => {
  const repo = repoWithNothingFlagged();
  const [result] = backtest({
    reader: readerFor(repo),
    db: null,
    config: config(),
    anchorSHA: repo.git(['rev-parse', 'HEAD']).trim(),
    splits: [SPLIT],
  });
  assert.ok(result);

  assert.ok(result.population > 0, 'files existed at the split');
  assert.ok(result.base_rate > 0, 'a fix after the split did touch one of them');
  // The flagging step ran and flagged nothing: that count is real, and it is
  // the ratio that has no value.
  assert.equal(result.fix_history.status, 'no-lift');
  assert.equal(result.fix_history.flagged, 0);
  assert.equal(result.fix_history.rate, null);
  assert.equal(result.fix_history.lift, null);
  assert.match(String(result.fix_history.reason), /flagged no file before the split/);
  assert.equal(result.fix_touch.status, 'no-lift');
  // The churn signal did have something to flag, so this split is not one of
  // the wholly unmeasurable ones.
  assert.equal(result.churn_top_decile.status, 'measured');
  assert.equal(result.note, null, 'the replay itself got through');
});

test('a split every signal flagged nothing on is not evaluated, and says why per signal', async () => {
  const repo = tempRepo('bt-nothing-at-all');
  // One file, created long before the split and never touched inside the
  // pre-split window - so even the churn decile has nothing to rank.
  repo.commitFiles('feat: seed', { 'src/a.ts': 'export const a = 0;\n' }, '2025-09-01T12:00:00Z');
  repo.commitFiles('fix: correct it after the split', { 'src/a.ts': 'export const a = 1;\n' }, '2026-04-10T12:00:00Z');
  const env = {
    EYES_HOME: stateRoot(),
    EYES_ON_SKILL_ROOT: tempDir('bt-unflagged-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NM_HOME: tempDir('bt-unflagged-nm'),
  };

  const json = await cli(['backtest', '--split', SPLIT, '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(json.out) as {
    evaluated: number;
    fix_history_measured: number;
    fix_history_pass: boolean;
    churn_decile_measured: number;
    churn_decile_pass: boolean;
    not_measured: { split: string; signal: string; reason: string }[];
    results: { note: string | null; fix_history_status: string; fix_history_lift: number | null }[];
  };

  assert.equal(doc.results[0]?.fix_history_status, 'no-lift');
  assert.equal(doc.results[0]?.fix_history_lift, null, 'an unmeasured lift is null, never 0');
  assert.equal(doc.results[0]?.note, null, 'the replay got through: the reason is per signal, not per split');
  assert.deepEqual(
    doc.not_measured.map((entry) => entry.signal),
    ['fix history', 'fix touch', 'churn top decile'],
    'every signal names itself and its reason',
  );
  for (const entry of doc.not_measured) {
    assert.match(entry.reason, /flagged no file before the split/);
  }
  assert.equal(doc.evaluated, 0, 'a split nothing was measured on is not evaluated');
  assert.equal(doc.fix_history_measured, 0);
  assert.equal(doc.churn_decile_measured, 0);
  assert.equal(doc.fix_history_pass, false, 'a verdict over no measurement is not a pass');
  assert.equal(doc.churn_decile_pass, false);

  const md = await cli(['backtest', '--split', SPLIT, '--format', 'md'], { cwd: repo.path, env });
  const cells = (md.out.split('\n').find((line) => line.startsWith(`| ${SPLIT} `)) ?? '')
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
  assert.deepEqual(
    cells,
    [SPLIT, '1', '0', 'not measured', '0', 'not measured', '0', 'not measured'],
    'every signal ran and flagged nothing: a real zero, and no lift',
  );
  // The verdict line must not read as a failure either: nothing was measured.
  assert.match(md.out, /over 0 of 1 splits: \*\*not measured\*\*/);
  assert.doesNotMatch(md.out, /splits: \*\*fail\*\*/);
  assert.match(md.out, /\*\*2026-03-01\*\*, fix history: .*flagged no file before the split/);
  assert.doesNotMatch(md.out, /went on to be fixed/, 'no file went on to be fixed here');
});

test('a measured split emphasises the two lifts the thresholds are about, and not the third', () => {
  const repo = repoWithSignal();
  const env = {
    EYES_HOME: stateRoot(),
    EYES_ON_SKILL_ROOT: tempDir('bt-measured-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NM_HOME: tempDir('bt-measured-nm'),
  };

  return cli(['backtest', '--split', SPLIT, '--format', 'md'], { cwd: repo.path, env }).then((md) => {
    const cells = (md.out.split('\n').find((line) => line.startsWith(`| ${SPLIT} `)) ?? '')
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    // split, files, fix-history flagged and lift, fix-touch flagged and lift,
    // churn flagged and lift.
    assert.equal(cells.length, 8);
    // The report sets a threshold on fix history and on the churn top decile,
    // and on nothing else; the emphasis follows that and is not decoration.
    assert.match(String(cells[3]), /^\*\*[0-9.]+x\*\*$/, 'the fix-history lift carries a threshold');
    assert.match(String(cells[5]), /^[0-9.]+x$/, 'the blame-free variant carries none');
    assert.match(String(cells[7]), /^\*\*[0-9.]+x\*\*$/, 'the churn top-decile lift carries a threshold');
    assert.doesNotMatch(md.out, /## What was not measured/, 'everything here was measured');
  });
});
