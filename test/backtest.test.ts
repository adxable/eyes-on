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
  assert.ok(
    result.fix_history.lift >= FIX_HISTORY_LIFT_TARGET,
    `fix-history lift ${result.fix_history.lift} is below the ${FIX_HISTORY_LIFT_TARGET}x the report asks for`,
  );
  assert.ok(
    result.churn_top_decile.lift >= CHURN_DECILE_LIFT_TARGET,
    `churn top-decile lift ${result.churn_top_decile.lift} is below ${CHURN_DECILE_LIFT_TARGET}x`,
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

test('a split that could not be measured says so in Markdown instead of reading as a zero lift', async () => {
  const repo = repoWithUnmeasurableSplits();
  const env = {
    EYES_HOME: stateRoot(),
    EYES_ON_SKILL_ROOT: tempDir('bt-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NM_HOME: tempDir('bt-nm-home'),
  };

  // 2026-03-01: files existed and fixes landed afterwards, but none of them
  // touched a file that existed at the split - base rate zero, nothing to
  // discriminate. 2026-06-01: nothing landed after it at all.
  const result = await cli(['backtest', '--split', '2026-03-01,2026-06-01', '--format', 'md'], {
    cwd: repo.path,
    env,
  });
  assert.equal(result.code, EXIT_OK);

  const json = await cli(['backtest', '--split', '2026-03-01,2026-06-01', '--format', 'json'], {
    cwd: repo.path,
    env,
  });
  const doc = JSON.parse(json.out) as {
    evaluated: number;
    results: { split: string; population: number; note: string | null }[];
  };
  assert.equal(doc.evaluated, 0, 'neither split was evaluated');
  const notes = new Map(doc.results.map((entry) => [entry.split, entry]));
  assert.match(String(notes.get('2026-03-01')?.note), /nothing to discriminate/);
  assert.ok((notes.get('2026-03-01')?.population ?? 0) > 0, 'the first split is populated, so it is not the empty case');
  assert.match(String(notes.get('2026-06-01')?.note), /no outcome to measure/);
  assert.ok((notes.get('2026-06-01')?.population ?? 0) > 0);

  // The Markdown a human reads must carry the same two sentences, and must not
  // present either split as a signal that scored zero.
  assert.doesNotMatch(result.out, /\*\*0x\*\*/, 'a lift of 0x reads as a failed signal, not as "not measured"');
  for (const split of ['2026-03-01', '2026-06-01']) {
    const row = result.out.split('\n').find((line) => line.startsWith(`| ${split} `));
    assert.ok(row, `${split} must still have a row`);
    assert.match(row, /not measured/, `${split} must say its lifts were not measured`);
  }
  assert.match(result.out, /2 of 2 splits were not measured/);
  assert.match(result.out, /nothing to discriminate/);
  assert.match(result.out, /no outcome to measure/);
});
