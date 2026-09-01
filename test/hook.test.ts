import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  installPostCommitHook,
  inspectPostCommitHook,
  removePostCommitHook,
  PRESERVED_HOOK,
} from '../src/git/hook.js';
import { tempDir, tempRepo, run } from './helpers.js';

test('the hook installs into the clone and is recognised as ours', () => {
  const repo = tempRepo('hook');
  const result = installPostCommitHook(repo.path, '/nonexistent/eyes-on', '/tmp/eyes-on-root');
  assert.equal(result.action, 'installed');
  assert.equal(inspectPostCommitHook(repo.path).managed, true);

  // A second install is a no-op, not a second hook.
  assert.equal(installPostCommitHook(repo.path, '/nonexistent/eyes-on', '/tmp/eyes-on-root').action, 'unchanged');
});

/**
 * The property the report insists on (M5, K5): a hook that was already there
 * belongs to somebody, and overwriting it would delete their configuration.
 */
test('a foreign hook is preserved and still runs after ours', () => {
  const repo = tempRepo('hook-foreign');
  const hooks = join(repo.path, '.git', 'hooks');
  const witness = join(repo.path, 'foreign-ran.txt');
  writeFileSync(join(hooks, 'post-commit'), `#!/bin/sh\necho ran > ${witness}\n`, { mode: 0o755 });
  chmodSync(join(hooks, 'post-commit'), 0o755);

  const result = installPostCommitHook(repo.path, '/nonexistent/eyes-on', '/tmp/eyes-on-root');
  assert.equal(result.action, 'preserved-foreign');
  assert.equal(result.preservedPath, join(hooks, PRESERVED_HOOK));
  assert.ok(readFileSync(join(hooks, PRESERVED_HOOK), 'utf8').includes('echo ran'));

  repo.commit('triggers the hook chain');
  assert.ok(existsSync(witness), 'the preserved hook still runs');
});

/**
 * Measured in the report (D.2): a post-commit hook that fails does not fail the
 * commit. eyes-on relies on that, so the reliance is tested rather than assumed.
 */
test('the hook never fails a commit, even with no daemon to talk to', () => {
  const repo = tempRepo('hook-nonblocking');
  installPostCommitHook(repo.path, '/definitely/not/a/binary', '/tmp/eyes-on-root');
  const sha = repo.commit('commits cleanly with the hook installed');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(run(repo.path, ['log', '--oneline']).trim().split('\n').length, 2);
});

test('a broken preserved hook still cannot fail the commit', () => {
  const repo = tempRepo('hook-broken-user');
  const hooks = join(repo.path, '.git', 'hooks');
  writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  chmodSync(join(hooks, 'post-commit'), 0o755);
  installPostCommitHook(repo.path, '/definitely/not/a/binary', '/tmp/eyes-on-root');

  const commit = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'empty'], {
    cwd: repo.path,
    encoding: 'utf8',
  });
  assert.equal(commit.status, 0, 'a failing user hook must not reject the commit');
});

test('removing our hook restores the one we displaced', () => {
  const repo = tempRepo('hook-restore');
  const hooks = join(repo.path, '.git', 'hooks');
  writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\n# theirs\n', { mode: 0o755 });
  chmodSync(join(hooks, 'post-commit'), 0o755);
  installPostCommitHook(repo.path, '/nonexistent/eyes-on', '/tmp/eyes-on-root');

  assert.equal(removePostCommitHook(repo.path), true);
  assert.ok(readFileSync(join(hooks, 'post-commit'), 'utf8').includes('# theirs'));
  assert.ok(!existsSync(join(hooks, PRESERVED_HOOK)));
});

test('a foreign hook is never silently discarded when a companion already exists', () => {
  const repo = tempRepo('hook-conflict');
  const hooks = join(repo.path, '.git', 'hooks');
  writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\n# theirs\n', { mode: 0o755 });
  writeFileSync(join(hooks, PRESERVED_HOOK), '#!/bin/sh\n# older theirs\n', { mode: 0o755 });
  assert.throws(() => installPostCommitHook(repo.path, '/nonexistent/eyes-on', '/tmp/eyes-on-root'), /already exists/);
  assert.ok(readFileSync(join(hooks, 'post-commit'), 'utf8').includes('# theirs'));
});

/**
 * The hook must reach the daemon that registered *this* clone. Before this was
 * fixed the hook carried only the binary path, so an install under a non-default
 * EYES_HOME produced a hook that talked to ~/.eyes-on and failed silently
 * forever - the hook discards output and always exits 0.
 */
test('the hook talks to the state root it was installed for, not the committing shell\'s', () => {
  const repo = tempRepo('hook-root');
  const witness = join(repo.path, 'notify-argv.txt');
  const fakeBinary = join(repo.path, 'fake-eyes-on');
  writeFileSync(fakeBinary, `#!/bin/sh\nprintf '%s\\n' "$*" > ${witness}\n`, { mode: 0o755 });
  chmodSync(fakeBinary, 0o755);

  installPostCommitHook(repo.path, fakeBinary, '/srv/eyes-on');
  // The hook fires its notification in the background, so run the installed
  // hook directly and wait for it rather than racing the commit.
  const hook = spawnSync('/bin/sh', [join(repo.path, '.git', 'hooks', 'post-commit')], {
    cwd: repo.path,
    encoding: 'utf8',
    env: { ...process.env, EYES_HOME: '/somewhere/else' },
  });
  assert.equal(hook.status, 0);
  for (let attempt = 0; attempt < 100 && !existsSync(witness); attempt += 1) {
    spawnSync('sleep', ['0.02']);
  }
  assert.ok(existsSync(witness), 'the hook never invoked the binary');
  assert.equal(readFileSync(witness, 'utf8').trim(), 'daemon notify-commit --root /srv/eyes-on');
});

/**
 * The whole `--watch` chain, driven the way a user drives it: the published
 * binary installs the hook, git fires it on a real commit, and the daemon that
 * `init` started records what it saw.
 *
 * The test above stops at the argv a stand-in binary receives, which leaves the
 * two halves either side of it unproven - whether the installed hook can
 * actually execute the real binary, and whether the notification reaches the
 * daemon that registered this clone. Either half can fail without reporting
 * anything: the hook discards output and exits 0, so a notification that never
 * arrives looks exactly like one that did.
 *
 * The evidence is the daemon's own log, which is a durable JSON-lines record
 * rather than an implementation detail: one `commit.observed` entry carrying
 * the repo id that `init` returned.
 */
test('the --watch hook installed by init reaches the daemon on a real commit', async () => {
  const repo = tempRepo('hk');
  const home = join(tempDir('hk'), 'e');
  // The published bin shim, not dist/src/cli/main.js: the hook only invokes a
  // binary it can execute, and the shim is the executable one.
  const binary = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'eyes-on.js');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EYES_HOME: home,
    EYES_ON_SKILL_ROOT: tempDir('hk'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NM_HOME: tempDir('hk'),
  };
  delete env.NO_MISTAKES_GATE;

  const init = spawnSync(process.execPath, [binary, 'init', '--watch', '--format', 'json'], {
    cwd: repo.path,
    env,
    encoding: 'utf8',
  });
  assert.equal(init.status, 0, `init failed: ${init.stderr}`);
  const registration = JSON.parse(init.stdout) as { repo_id: string; hook: string };
  assert.equal(registration.hook, 'installed');

  try {
    repo.commit('a commit the daemon must observe');

    const logPath = join(home, 'logs', 'daemon.log');
    let observed: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 100 && !observed; attempt += 1) {
      const lines = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [];
      observed =
        lines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((entry) => entry.event === 'commit.observed' && entry.repoID === registration.repo_id) ?? null;
      if (!observed) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(observed, 'the commit fired the hook but no notification reached the daemon');
  } finally {
    spawnSync(process.execPath, [binary, 'daemon', 'stop'], { cwd: repo.path, env, encoding: 'utf8' });
  }
});
