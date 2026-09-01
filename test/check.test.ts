import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { run as runCli } from '../src/cli/run.js';
import { EXIT_ERROR, EXIT_OK, type Writers } from '../src/cli/output.js';
import { tempDir, tempRepo, type TempRepo } from './helpers.js';

/**
 * `check`, `why` and `export-path-instructions` end to end, and the two stage 1
 * acceptance conditions they carry: the noise filter and non-blocking.
 */

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function cli(argv: string[], options: { cwd: string; env: Record<string, string> }): Promise<Captured> {
  let out = '';
  let err = '';
  const writers: Writers = { out: (chunk) => (out += chunk), err: (chunk) => (err += chunk) };
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  process.chdir(options.cwd);
  delete process.env.NO_MISTAKES_GATE;
  Object.assign(process.env, options.env);
  try {
    const code = await runCli(argv, writers);
    return { code, out, err };
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

function sandbox(): Record<string, string> {
  return {
    EYES_HOME: join(tempDir('check-home'), 'eyes-on'),
    EYES_ON_SKILL_ROOT: tempDir('check-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NM_HOME: tempDir('check-nm-home'),
  };
}

/**
 * Registers the repository and stops the daemon that `init` started when the
 * test ends.
 *
 * Every `init` starts a real daemon process. The state root it serves is a
 * temporary directory the suite removes on exit, but the process is not, and a
 * suite that leaves one behind per test quietly fills the machine with daemons
 * serving directories that no longer exist.
 */
async function initRepo(t: TestContext, repo: TempRepo, env: Record<string, string>): Promise<void> {
  await cli(['init'], { cwd: repo.path, env });
  t.after(async () => {
    await cli(['daemon', 'stop'], { cwd: repo.path, env });
  });
}

/**
 * A repository shaped like the problem the noise filter solves: a documentation
 * file and a log-shaped data file that churn constantly and attract every fix,
 * beside one code file that is touched far less often.
 */
function noisyRepo(): TempRepo {
  const repo = tempRepo('noise');
  for (let index = 0; index < 12; index += 1) {
    repo.commitFiles(`docs: note ${index}`, {
      'AGENTS.md': `notes\n${'entry\n'.repeat(index + 1)}`,
      'data/events.jsonl': `${'{"e":1}\n'.repeat(index + 1)}`,
    });
    repo.commitFiles(`fix: correct note ${index}`, {
      'AGENTS.md': `notes\n${'corrected\n'.repeat(index + 1)}`,
      'data/events.jsonl': `${'{"e":2}\n'.repeat(index + 1)}`,
    });
  }
  repo.commitFiles('feat: one quiet code file', { 'src/quiet.ts': 'export const quiet = 1;\n' });
  return repo;
}

test('acceptance: no .md or .jsonl file appears in the risk ranking', async (t) => {
  const repo = noisyRepo();
  repo.git(['checkout', '-q', '-b', 'work']);
  repo.commitFiles('feat: change everything at once', {
    'AGENTS.md': 'notes\nchanged\n',
    'data/events.jsonl': '{"e":3}\n',
    'src/quiet.ts': 'export const quiet = 2;\n',
  });

  const env = sandbox();
  await initRepo(t, repo, env);
  const result = await cli(['check', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as {
    changed_files: number;
    code_files: number;
    top_files: { path: string }[];
    signals: { name: string; from: string | null }[];
  };

  assert.equal(doc.changed_files, 3, 'all three files are in the change');
  assert.equal(doc.code_files, 1, 'only one of them is code');
  const ranked = doc.top_files.map((file) => file.path);
  assert.deepEqual(ranked, ['src/quiet.ts']);
  for (const path of ranked) {
    assert.ok(!path.endsWith('.md') && !path.endsWith('.jsonl'), `${path} is noise and must not be ranked`);
  }
  // Without the filter, AGENTS.md - 24 commits and 12 fixes - would decide
  // every history signal. It decides none of them.
  for (const signal of doc.signals) {
    assert.ok(
      signal.from === null || !signal.from.endsWith('.md'),
      `${signal.name} was decided by ${String(signal.from)}`,
    );
  }
});

test('acceptance: a hard-rule hit sets the band to pelna and still exits 0', async (t) => {
  const repo = tempRepo('band');
  repo.commitFiles('chore: configure', {
    '.eyes-on.yml': 'schema: eyes-on/v1\nhard_rules:\n  - glob: "deploy/**"\n    why: "costs a machine"\n',
    'src/a.ts': 'export const a = 1;\n',
  });
  repo.git(['checkout', '-q', '-b', 'deployment']);
  repo.commitFiles('chore: bump replicas', { 'deploy/values.yaml': 'replicas: 4\n' });

  const env = sandbox();
  await initRepo(t, repo, env);

  const lenient = await cli(['check', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(lenient.out) as { band: string; band_from: string; score: number; exit_code: number };
  assert.equal(doc.band, 'pelna');
  assert.equal(doc.band_from, 'hard rule');
  assert.ok(doc.score < 65, 'the score alone would not have reached the top band');
  assert.equal(lenient.code, EXIT_OK, 'eyes-on never blocks without --strict');
  assert.equal(doc.exit_code, 0);

  const strict = await cli(['check', '--strict', '--format', 'json'], { cwd: repo.path, env });
  assert.equal(strict.code, EXIT_ERROR, '--strict is the only door out of exit 0');
  // The payload says what actually happened: an agent reading `exit_code` must
  // never be told 0 while the shell sees 1.
  assert.equal((JSON.parse(strict.out) as { exit_code: number }).exit_code, EXIT_ERROR);
});

test('the score, the band, the rationale and the report file agree with each other', async (t) => {
  const repo = tempRepo('record');
  repo.commitFiles('feat: something to change', { 'src/a.ts': 'export const a = 1;\n' });
  repo.git(['checkout', '-q', '-b', 'work']);
  repo.commitFiles('feat: change it', { 'src/a.ts': 'export const a = 2;\n' });

  const env = sandbox();
  await initRepo(t, repo, env);
  const result = await cli(['check', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as {
    check_id: string;
    score: number;
    band: string;
    head: string;
    signals: { name: string; points: number }[];
  };

  const summed = doc.signals.reduce((sum, signal) => sum + signal.points, 0);
  assert.ok(Math.abs(summed - doc.score) <= doc.signals.length, 'the signal points add up to the score');
  assert.ok(doc.check_id.length > 0, 'the assessment was recorded');

  const head = repo.git(['rev-parse', 'HEAD']).trim();
  const reportFile = join(env.EYES_HOME as string, 'reports', `${head}.json`);
  assert.ok(existsSync(reportFile), 'the full report was written next to the state');
  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { score: number; files: { path: string }[] };
  assert.equal(report.score, doc.score);
  assert.deepEqual(
    report.files.map((file) => file.path),
    ['src/a.ts'],
  );
});

test('a check with nothing to compare against says so instead of scoring the repository', async (t) => {
  const repo = tempRepo('empty-range');
  const env = sandbox();
  await initRepo(t, repo, env);
  // A single-commit repository on its default branch: there is no base.
  repo.git(['update-ref', '-d', 'refs/remotes/origin/HEAD']);
  const result = await cli(['check', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as { changed_files: number; score: number; band: string; base_from: string };
  assert.equal(doc.changed_files, 0);
  assert.equal(doc.score, 0);
  assert.equal(doc.band, 'auto');
  assert.match(doc.base_from, /no parent commit/);
  assert.equal(result.code, EXIT_OK);
});

test('why explains one file with the fixes that actually pointed at it', async (t) => {
  const repo = tempRepo('why');
  repo.commitFiles('feat: introduce', { 'src/hot.ts': 'one\ntwo\nthree\n' });
  repo.commitFiles('fix: correct the second line', { 'src/hot.ts': 'one\nTWO\nthree\n' });
  repo.commitFiles('fix: correct the third line', { 'src/hot.ts': 'one\nTWO\nTHREE\n' });

  const env = sandbox();
  await initRepo(t, repo, env);
  const result = await cli(['why', 'src/hot.ts', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as {
    file: string;
    code: boolean;
    fix_commits: number;
    churn: number;
    fixes: { subject: string }[];
    rank: number;
  };
  assert.equal(doc.file, 'src/hot.ts');
  assert.equal(doc.code, true);
  assert.equal(doc.fix_commits, 2);
  assert.equal(doc.churn, 3);
  assert.equal(doc.rank, 1);
  assert.deepEqual(
    doc.fixes.map((fix) => fix.subject),
    ['fix: correct the third line', 'fix: correct the second line'],
  );
  assert.equal(result.code, EXIT_OK);
});

test('why on a file the filter excludes says why it scores nothing', async (t) => {
  const repo = noisyRepo();
  const env = sandbox();
  await initRepo(t, repo, env);
  const result = await cli(['why', 'AGENTS.md', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as { code: boolean; rank: number | null; help: string[] };
  assert.equal(doc.code, false);
  assert.equal(doc.rank, null, 'a file outside the code filter is not in the ranking at all');
  assert.match(doc.help.join(' '), /not code by the trusted include\/exclude patterns/);
});

test('export-path-instructions emits a block inside both caps, hard rules first', async (t) => {
  const repo = tempRepo('export');
  repo.commitFiles('chore: configure', {
    '.eyes-on.yml': 'schema: eyes-on/v1\nhard_rules:\n  - glob: "deploy/**"\n    why: "costs a machine"\n',
  });
  for (let index = 0; index < 6; index += 1) {
    repo.commitFiles(`fix: round ${index}`, { 'src/hot.ts': `export const v = ${index};\n` });
  }

  const env = sandbox();
  await initRepo(t, repo, env);
  const result = await cli(['export-path-instructions', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as {
    entries: number;
    bytes: number;
    max_entries: number;
    max_bytes: number;
    within_caps: boolean;
    block: string;
  };

  assert.equal(doc.within_caps, true);
  assert.ok(doc.entries <= doc.max_entries);
  assert.ok(doc.bytes <= doc.max_bytes);
  assert.match(doc.block, /path: "deploy\/\*\*"/);
  assert.match(doc.block, /review:\n {2}path_instructions:/);
  assert.equal(result.code, EXIT_OK);
});
