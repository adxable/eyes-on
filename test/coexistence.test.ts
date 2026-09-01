import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { run as runCli } from '../src/cli/run.js';
import { EXIT_OK, EXIT_USAGE, type Writers } from '../src/cli/output.js';
import {
  CLONE_READ_ONLY_SUBCOMMANDS,
  commonGitDir,
  currentBranch,
  defaultBranch,
  gitReadClone,
  headSHA,
  hooksDir,
  isGitRepo,
  toplevel,
} from '../src/git/git.js';
import { ensureMirror } from '../src/git/mirror.js';
import { tempDir, tempRepo, run } from './helpers.js';

/**
 * The stage 0 acceptance conditions from report section 4 and section 8, as
 * automated tests. The report is explicit that this list is where the
 * implementation carries regression tests, so these assertions are the contract
 * rather than an illustration of it.
 *
 * The two conditions that need a live no-mistakes install and a real service
 * manager are exercised by hand as well; see docs/stage-0-acceptance.md for
 * those measurements.
 */

async function cli(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  let out = '';
  let err = '';
  const writers: Writers = { out: (chunk) => (out += chunk), err: (chunk) => (err += chunk) };
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  if (options.cwd) process.chdir(options.cwd);
  // The suite must behave identically inside and outside a no-mistakes run.
  // The pipeline stamps NO_MISTAKES_GATE=1 on every process it spawns, and
  // eyes-on refuses to mutate under it, so an inherited marker would turn every
  // init in this file into a recursion refusal. Tests that want that refusal
  // set the marker themselves through options.env.
  delete process.env.NO_MISTAKES_GATE;
  Object.assign(process.env, options.env ?? {});
  try {
    return { code: await runCli(argv, writers), out, err };
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

/** Every file under dir with an mtime newer than the marker. */
function newerThan(dir: string, marker: number): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      try {
        if (statSync(full).mtimeMs > marker) found.push(full);
      } catch {
        continue;
      }
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return found;
}

test('acceptance: a full session leaves a foreign state root untouched', async () => {
  const repo = tempRepo('coex-foreign');
  const nmHome = tempDir('coex-nm-home');
  // A stand-in for ~/.no-mistakes with the same shape: gate, worktrees, state.
  mkdirSync(join(nmHome, 'repos', 'abc.git', 'hooks'), { recursive: true });
  mkdirSync(join(nmHome, 'worktrees'), { recursive: true });
  writeFileSync(join(nmHome, 'state.sqlite'), 'not a real database');
  writeFileSync(join(nmHome, 'config.yaml'), 'schema: no-mistakes\n');
  writeFileSync(join(nmHome, 'repos', 'abc.git', 'hooks', 'pre-receive'), '#!/bin/sh\nexit 0\n');

  const env = {
    EYES_HOME: join(tempDir('coex-eyes-home'), 'eyes-on'),
    EYES_ON_SKILL_ROOT: tempDir('coex-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NM_HOME: nmHome,
  };

  // The marker: everything written after this instant is a violation.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const marker = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 20));

  try {
    assert.equal((await cli(['init', '--watch'], { cwd: repo.path, env })).code, EXIT_OK);
    await cli(['doctor'], { cwd: repo.path, env });
    await cli(['status'], { cwd: repo.path, env });
    await cli(['daemon', 'status'], { cwd: repo.path, env });
    repo.commit('a commit that fires the hook');
    await cli(['init'], { cwd: repo.path, env });
  } finally {
    await cli(['daemon', 'stop'], { env });
  }

  assert.deepEqual(newerThan(nmHome, marker), [], 'eyes-on wrote into the no-mistakes state root');
});

/** Every path under dir, relative and sorted, so "nothing was written" can be
 *  asserted as an equality rather than as an absence of warnings. */
function inventory(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      found.push(relative);
      if (entry.isDirectory()) walk(join(current, entry.name), relative);
    }
  };
  walk(dir, '');
  return found;
}

/**
 * The first hard prohibition, enforced rather than described.
 *
 * Every file eyes-on writes lives under its state root, so a root nested
 * anywhere inside the no-mistakes home puts config, database, mirrors, logs and
 * socket under `~/.no-mistakes/**` at once. The refusal therefore belongs where
 * the root is resolved, before any command can act on it - and what this
 * asserts is that nothing was written, not that a warning was printed.
 */
test('acceptance: a state root inside the no-mistakes home is refused before anything is written', async () => {
  const repo = tempRepo('coex-nested');
  const nmHome = tempDir('coex-nested-nm');
  mkdirSync(join(nmHome, 'repos', 'abc.git'), { recursive: true });
  writeFileSync(join(nmHome, 'state.sqlite'), 'not a real database');
  const before = inventory(nmHome);

  const nested = join(nmHome, 'eyes-on');
  const env = {
    EYES_HOME: nested,
    EYES_ON_SKILL_ROOT: tempDir('coex-nested-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NM_HOME: nmHome,
  };

  for (const argv of [
    ['init'],
    ['init', '--watch'],
    ['doctor'],
    ['status'],
    ['daemon', 'start'],
    ['daemon', 'status'],
    ['daemon', 'run', '--root', join(nmHome, 'deeper', 'still', 'eyes-on')],
  ]) {
    const result = await cli(argv, { cwd: repo.path, env });
    assert.equal(result.code, EXIT_USAGE, `eyes-on ${argv.join(' ')} must be refused`);
    assert.match(result.err, /is inside the no-mistakes state root/);
    assert.match(result.err, /help: Set EYES_HOME/, 'a refusal must say how to pick a different root');
  }

  assert.equal(existsSync(nested), false, 'the refused state root must not exist');
  assert.deepEqual(inventory(nmHome), before, 'eyes-on wrote into the no-mistakes state root');
});

test('acceptance: the working clone is byte-identical before and after', async () => {
  const repo = tempRepo('coex-clone');
  const env = {
    EYES_HOME: join(tempDir('coex-clone-home'), 'eyes-on'),
    EYES_ON_SKILL_ROOT: tempDir('coex-clone-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    // Private, so the guard does not read a suite running from under the real
    // `<NM_HOME>/worktrees` as a pipeline descendant.
    NM_HOME: tempDir('coex-clone-nm-home'),
  };

  const statusBefore = run(repo.path, ['status', '--porcelain']);
  const refsBefore = run(repo.path, ['for-each-ref']);
  const remotesBefore = run(repo.path, ['remote', '-v']);
  const configBefore = run(repo.path, ['config', '--local', '--list']);

  try {
    await cli(['init'], { cwd: repo.path, env });
    await cli(['doctor'], { cwd: repo.path, env });
    await cli(['status'], { cwd: repo.path, env });
    await cli(['init'], { cwd: repo.path, env });
  } finally {
    await cli(['daemon', 'stop'], { env });
  }

  assert.equal(run(repo.path, ['status', '--porcelain']), statusBefore, 'the working tree changed');
  assert.equal(run(repo.path, ['for-each-ref']), refsBefore, 'a ref moved in the clone');
  assert.equal(run(repo.path, ['remote', '-v']), remotesBefore, 'a remote was added');
  assert.equal(run(repo.path, ['config', '--local', '--list']), configBefore, 'local config changed');
});

test('acceptance: creating and refreshing the mirror stays inside the cost budget', async () => {
  const repo = tempRepo('coex-cost');
  for (let index = 0; index < 50; index += 1) {
    repo.commit(`commit ${index}`, `file-${index}.txt`, 'x'.repeat(2048));
  }
  const env = {
    EYES_HOME: join(tempDir('coex-cost-home'), 'eyes-on'),
    EYES_ON_SKILL_ROOT: tempDir('coex-cost-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    // Private, so the guard does not read a suite running from under the real
    // `<NM_HOME>/worktrees` as a pipeline descendant.
    NM_HOME: tempDir('coex-cost-nm-home'),
  };
  try {
    const created = JSON.parse((await cli(['init', '--format', 'json'], { cwd: repo.path, env })).out) as {
      mirror_fetch_ms: number;
      mirror_bytes: number;
    };
    assert.ok(created.mirror_fetch_ms < 1000, `mirror creation took ${created.mirror_fetch_ms} ms`);
    assert.ok(created.mirror_bytes < 5 * 1024 * 1024, `mirror is ${created.mirror_bytes} bytes`);

    const refreshed = JSON.parse((await cli(['init', '--format', 'json'], { cwd: repo.path, env })).out) as {
      mirror_fetch_ms: number;
    };
    assert.ok(refreshed.mirror_fetch_ms < 500, `incremental fetch took ${refreshed.mirror_fetch_ms} ms`);
  } finally {
    await cli(['daemon', 'stop'], { env });
  }
});

test('acceptance: inside a no-mistakes run, mutation is refused and reads still work', async () => {
  const repo = tempRepo('coex-recursion');
  const env = {
    EYES_HOME: join(tempDir('coex-rec-home'), 'eyes-on'),
    EYES_ON_SKILL_ROOT: tempDir('coex-rec-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NO_MISTAKES_GATE: '1',
  };

  const check = await cli(['check'], { cwd: repo.path, env });
  assert.equal(check.code, EXIT_USAGE);
  assert.match(check.err, /refusing to run "check" from inside a no-mistakes run/);

  const init = await cli(['init'], { cwd: repo.path, env });
  assert.equal(init.code, EXIT_USAGE, 'init mutates state, so it is refused too');

  const status = await cli(['status', '--format', 'json'], { cwd: repo.path, env });
  assert.equal(status.code, EXIT_OK, 'reads must keep working inside a gate');
  assert.equal((JSON.parse(status.out) as { inside_no_mistakes_run: boolean }).inside_no_mistakes_run, true);

  const doctor = await cli(['doctor'], { cwd: repo.path, env });
  assert.notEqual(doctor.code, EXIT_USAGE, 'doctor is read-only and must not be refused');
});

/**
 * K2 as an executable rule rather than a review promise.
 *
 * `git()` is module-private, so the only exported ways a clone can appear in a
 * git invocation are `gitReadClone()` - which refuses anything outside the
 * read-only allow-list - and `fetchCloneIntoMirror()`, which never runs inside
 * the clone and writes only into the mirror. Both halves are asserted here,
 * because "the allow-list is the enforcement point" is only true while every
 * clone-touching helper actually goes through it.
 */
test('acceptance: no write-capable git subcommand can reach a working clone', () => {
  const repo = tempRepo('coex-allowlist');
  for (const forbidden of ['checkout', 'reset', 'fetch', 'push', 'gc', 'stash', 'update-ref', 'commit', 'clean']) {
    assert.ok(
      !CLONE_READ_ONLY_SUBCOMMANDS.includes(forbidden),
      `${forbidden} must never be on the clone allow-list`,
    );
    assert.throws(() => gitReadClone(repo.path, [forbidden]), /only reads clones/);
  }
  assert.doesNotThrow(() => gitReadClone(repo.path, ['status', '--porcelain']));
});

/**
 * The three allow-listed subcommands that write when told to. Refusing them by
 * name would break the reads the product depends on, so the guard is
 * argument-aware - and that is exactly the kind of rule a later edit could
 * loosen without noticing, so each write form is asserted here.
 */
test('acceptance: the write forms of config, remote and symbolic-ref are refused', () => {
  const repo = tempRepo('coex-writeforms');
  const refsBefore = run(repo.path, ['for-each-ref']);
  const configBefore = run(repo.path, ['config', '--local', '--list']);
  const remotesBefore = run(repo.path, ['remote', '-v']);

  const writeForms = [
    ['config', 'core.hooksPath', '/tmp/eyes-on-should-never-write'],
    ['config', '--add', 'eyes-on.marker', '1'],
    ['config', '--unset', 'user.name'],
    ['remote', 'add', 'eyes-on', '/tmp/nowhere'],
    ['remote', 'set-url', 'origin', '/tmp/nowhere'],
    ['symbolic-ref', 'HEAD', 'refs/heads/somewhere-else'],
    ['symbolic-ref', '--delete', 'HEAD'],
  ];
  for (const form of writeForms) {
    assert.throws(() => gitReadClone(repo.path, form), /only reads clones/, `git ${form.join(' ')} must be refused`);
  }

  // The read forms the product actually uses keep working.
  assert.doesNotThrow(() => gitReadClone(repo.path, ['config', '--get', 'user.name']));
  assert.doesNotThrow(() => gitReadClone(repo.path, ['config', '--local', '--list']));
  assert.doesNotThrow(() => gitReadClone(repo.path, ['remote', '-v']));
  assert.doesNotThrow(() => gitReadClone(repo.path, ['symbolic-ref', '--short', '-q', 'HEAD']));

  assert.equal(run(repo.path, ['for-each-ref']), refsBefore, 'a ref moved in the clone');
  assert.equal(run(repo.path, ['config', '--local', '--list']), configBefore, 'local config changed');
  assert.equal(run(repo.path, ['remote', '-v']), remotesBefore, 'a remote was added');
});

test('acceptance: every clone-reading helper answers without tripping the allow-list', () => {
  const repo = tempRepo('coex-helpers');
  // What this shows is that the helpers still work now that they run through
  // gitReadClone: none of them is refused, and each returns what it read. The
  // rule that they *must* go through it is enforced by the module boundary -
  // git() is not exported - which no test can observe from the outside.
  assert.equal(toplevel(repo.path), repo.path);
  assert.ok(isGitRepo(repo.path));
  assert.ok(commonGitDir(repo.path)?.length);
  assert.ok(hooksDir(repo.path)?.endsWith('hooks'));
  assert.match(headSHA(repo.path) ?? '', /^[0-9a-f]{40}$/);
  assert.ok((currentBranch(repo.path) ?? '').length > 0);
  assert.ok(defaultBranch(repo.path).length > 0);
});

/**
 * The one invocation that names a clone without being on the allow-list. It is
 * allowed because of what it does, not because of what it is called: the clone
 * is the fetch *source*, read through upload-pack, and the assertions below are
 * the reason that distinction is safe.
 */
test('acceptance: the mirror fetch reads the clone and writes only into the mirror', () => {
  const repo = tempRepo('coex-fetch');
  repo.commit('something to fetch');
  const mirrorPath = join(tempDir('coex-fetch-mirror'), 'mirror.git');

  const statusBefore = run(repo.path, ['status', '--porcelain']);
  const refsBefore = run(repo.path, ['for-each-ref']);
  const configBefore = run(repo.path, ['config', '--local', '--list']);
  const remotesBefore = run(repo.path, ['remote', '-v']);

  const result = ensureMirror(mirrorPath, repo.path);
  assert.ok(result.status.refs > 0, 'the mirror gained the clone\'s heads');

  assert.equal(run(repo.path, ['status', '--porcelain']), statusBefore, 'the working tree changed');
  assert.equal(run(repo.path, ['for-each-ref']), refsBefore, 'a ref moved in the clone');
  assert.equal(run(repo.path, ['config', '--local', '--list']), configBefore, 'local config changed');
  assert.equal(run(repo.path, ['remote', '-v']), remotesBefore, 'a remote was added to the clone');
});
