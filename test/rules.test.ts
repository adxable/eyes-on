import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { run as runCli } from '../src/cli/run.js';
import { EXIT_ERROR, EXIT_OK, type Writers } from '../src/cli/output.js';
import { stateRoot, tempDir, tempRepo, type TempRepo } from './helpers.js';
import { evaluateHardRules } from '../src/rules/hard.js';
import { readTrustedConfig } from '../src/rules/trusted.js';
import { RepoReader } from '../src/git/reader.js';

/**
 * The trust property, which is the acceptance condition for stage 1's rules:
 * **a branch that deletes a rule from `.eyes-on.yml` still gets that rule.**
 *
 * Everything else in this file exists to make that one sentence checkable from
 * more than one direction.
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
    EYES_HOME: stateRoot(),
    EYES_ON_SKILL_ROOT: tempDir('rules-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NM_HOME: tempDir('rules-nm-home'),
  };
}

const CONFIG = `schema: eyes-on/v1
hard_rules:
  - glob: "deploy/**"
    why: "deployment configuration - a mistake costs a machine, not a test"
`;

/** A repository whose default branch carries one hard rule over `deploy/**`. */
function repoWithRule(prefix: string): TempRepo {
  const repo = tempRepo(prefix);
  repo.commitFiles('chore: add the eyes-on configuration', { '.eyes-on.yml': CONFIG });
  return repo;
}

function readerFor(repo: TempRepo): RepoReader {
  return new RepoReader({ clonePath: repo.path, mirrorPath: join(tempDir('rules-mirror'), 'absent.git') });
}

test('acceptance: a branch that deletes the rule still gets the rule', async () => {
  const repo = repoWithRule('trust');
  repo.git(['checkout', '-q', '-b', 'sneaky']);
  // The branch removes the configuration entirely and then changes exactly the
  // path the deleted rule protected.
  repo.commitFiles('chore: simplify configuration', {
    '.eyes-on.yml': null,
    'deploy/values.yaml': 'replicas: 3\n',
  });

  const result = await cli(['rules', '--check', '--format', 'json'], { cwd: repo.path, env: sandbox() });
  const doc = JSON.parse(result.out) as {
    rules_evaluated: number;
    rules_hit: number;
    band: string;
    config_state: string;
    hard_rules: { glob: string; matched_files: string }[];
  };

  assert.equal(doc.config_state, 'trusted', 'the rule was read from the default branch, not from the branch');
  assert.equal(doc.rules_evaluated, 1);
  assert.equal(doc.rules_hit, 1);
  assert.equal(doc.band, 'pelna');
  assert.equal(doc.hard_rules[0]?.glob, 'deploy/**');
  assert.match(doc.hard_rules[0]?.matched_files ?? '', /deploy\/values\.yaml/);
  assert.equal(result.code, EXIT_OK);
});

test('acceptance: a branch that invents a rule does not get it', async () => {
  const repo = tempRepo('trust-add');
  repo.commitFiles('chore: seed the default branch without rules', { 'src/a.ts': 'export const a = 1;\n' });
  repo.git(['checkout', '-q', '-b', 'inventive']);
  repo.commitFiles('chore: add a rule and something for it to match', {
    '.eyes-on.yml': 'schema: eyes-on/v1\nhard_rules:\n  - glob: "src/**"\n    why: "mine"\n',
    'src/b.ts': 'export const b = 2;\n',
  });

  const result = await cli(['rules', '--check', '--format', 'json'], { cwd: repo.path, env: sandbox() });
  const doc = JSON.parse(result.out) as { rules_evaluated: number; rules_hit: number; config_state: string };
  assert.equal(doc.config_state, 'absent', 'the default branch has no configuration, so there is nothing to trust');
  assert.equal(doc.rules_evaluated, 0);
  assert.equal(doc.rules_hit, 0);
});

test('acceptance: an unreadable trusted configuration is unverified, never silently empty', () => {
  const repo = tempRepo('trust-broken');
  repo.commitFiles('chore: a configuration nobody can read', {
    '.eyes-on.yml': 'schema: eyes-on/v1\nthresholds: { read_fragments: 80, full_review: 20 }\n',
  });
  const trusted = readTrustedConfig(repo.path, readerFor(repo));
  assert.equal(trusted.state, 'unverified');
  assert.match(trusted.detail ?? '', /must be below/);
  assert.match(trusted.detail ?? '', /no hard rule was evaluated/);
});

test('an absent configuration is absent, not unverified: there is nothing to be uncertain about', () => {
  const repo = tempRepo('trust-absent');
  const trusted = readTrustedConfig(repo.path, readerFor(repo));
  assert.equal(trusted.state, 'absent');
  assert.equal(trusted.detail, null);
  assert.deepEqual(trusted.config.hard_rules, []);
});

test('the trusted read is pinned to a commit and names it', () => {
  const repo = repoWithRule('trust-pin');
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  const trusted = readTrustedConfig(repo.path, readerFor(repo));
  assert.equal(trusted.state, 'trusted');
  assert.equal(trusted.sha, head);
  assert.equal(trusted.branch, 'main');
  assert.equal(trusted.ref, 'refs/heads/main');
});

test('rules match the full changed-file list, before any code filter', () => {
  // `deploy/values.yaml` is not code by any include pattern eyes-on ships. A
  // rule about it must still fire, or the strongest guarantee in the product
  // would quietly depend on a list of file extensions.
  const hits = evaluateHardRules(
    [{ glob: 'deploy/**', why: 'deployment configuration' }],
    ['src/a.ts', 'deploy/values.yaml', 'docs/notes.md'],
  );
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0]?.matched_files, ['deploy/values.yaml']);
});

test('acceptance: a hard-rule hit exits 0, and only --strict changes that', async () => {
  const repo = repoWithRule('nonblocking');
  repo.git(['checkout', '-q', '-b', 'touching-deploy']);
  repo.commitFiles('feat: change the deployment', { 'deploy/values.yaml': 'replicas: 5\n' });
  const env = sandbox();

  const lenient = await cli(['rules', '--check', '--format', 'json'], { cwd: repo.path, env });
  assert.equal(JSON.parse(lenient.out).rules_hit, 1);
  assert.equal(lenient.code, EXIT_OK, 'a rule hit never blocks on its own');
  assert.equal(JSON.parse(lenient.out).exit_code, EXIT_OK);

  const strict = await cli(['rules', '--check', '--strict', '--format', 'json'], { cwd: repo.path, env });
  assert.equal(JSON.parse(strict.out).rules_hit, 1);
  assert.equal(strict.code, EXIT_ERROR, '--strict is the only door out of exit 0');
  // The document reports the exit code the process used, not the one the
  // common case has.
  assert.equal(JSON.parse(strict.out).exit_code, EXIT_ERROR);
});

test('a hard rule fires on a path whose name git C-quotes', () => {
  // Git wraps any path with a non-ASCII byte in double quotes and escapes the
  // bytes in octal, so `deploy/wartości.yaml` is reported as
  // `"deploy/warto\\305\\233ci.yaml"`. Unquoted, that string matches no glob:
  // the rule written for exactly this path would silently not fire.
  const repo = repoWithRule('quoted');
  repo.git(['checkout', '-q', '-b', 'diacritics']);
  repo.commitFiles('chore: bump replicas', { 'deploy/wartości.yaml': 'replicas: 4\n' });

  const reader = readerFor(repo);
  const base = repo.git(['rev-parse', 'main']).trim();
  const head = repo.git(['rev-parse', 'HEAD']).trim();

  const changed = reader.changedFiles(base, head).map((file) => file.path);
  assert.deepEqual(changed, ['deploy/wartości.yaml'], 'the path git quoted must reach the rule as itself');

  const trusted = readTrustedConfig(repo.path, reader);
  const hits = evaluateHardRules(trusted.config.hard_rules, changed);
  assert.equal(hits.length, 1, 'the deploy/** rule must fire on it');
  assert.deepEqual(hits[0]?.matched_files, ['deploy/wartości.yaml']);

  // The tree listing quotes the same way, and the backtest population is built
  // from it. The patch header is covered by the SZZ chain in test/szz.test.ts.
  assert.ok(reader.filesAt(head).includes('deploy/wartości.yaml'));
});

test('a hard-rule hit on a diacritic path sets the band and still exits 0', async () => {
  const repo = repoWithRule('quoted-band');
  repo.git(['checkout', '-q', '-b', 'diacritics']);
  repo.commitFiles('chore: bump replicas', { 'deploy/wartości.yaml': 'replicas: 4\n' });
  const env = sandbox();

  const result = await cli(['rules', '--check', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as { band: string; rules_hit: number; hard_rules: { matched_files: string }[] };
  assert.equal(doc.rules_hit, 1);
  assert.equal(doc.band, 'pelna');
  assert.equal(doc.hard_rules[0]?.matched_files, 'deploy/wartości.yaml');
  assert.equal(result.code, EXIT_OK);
});
