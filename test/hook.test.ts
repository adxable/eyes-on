import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  installPostCommitHook,
  inspectPostCommitHook,
  removePostCommitHook,
  PRESERVED_HOOK,
} from '../src/git/hook.js';
import { tempRepo, run } from './helpers.js';

test('the hook installs into the clone and is recognised as ours', () => {
  const repo = tempRepo('hook');
  const result = installPostCommitHook(repo.path, '/nonexistent/eyes-on');
  assert.equal(result.action, 'installed');
  assert.equal(inspectPostCommitHook(repo.path).managed, true);

  // A second install is a no-op, not a second hook.
  assert.equal(installPostCommitHook(repo.path, '/nonexistent/eyes-on').action, 'unchanged');
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

  const result = installPostCommitHook(repo.path, '/nonexistent/eyes-on');
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
  installPostCommitHook(repo.path, '/definitely/not/a/binary');
  const sha = repo.commit('commits cleanly with the hook installed');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(run(repo.path, ['log', '--oneline']).trim().split('\n').length, 2);
});

test('a broken preserved hook still cannot fail the commit', () => {
  const repo = tempRepo('hook-broken-user');
  const hooks = join(repo.path, '.git', 'hooks');
  writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  chmodSync(join(hooks, 'post-commit'), 0o755);
  installPostCommitHook(repo.path, '/definitely/not/a/binary');

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
  installPostCommitHook(repo.path, '/nonexistent/eyes-on');

  assert.equal(removePostCommitHook(repo.path), true);
  assert.ok(readFileSync(join(hooks, 'post-commit'), 'utf8').includes('# theirs'));
  assert.ok(!existsSync(join(hooks, PRESERVED_HOOK)));
});

test('a foreign hook is never silently discarded when a companion already exists', () => {
  const repo = tempRepo('hook-conflict');
  const hooks = join(repo.path, '.git', 'hooks');
  writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\n# theirs\n', { mode: 0o755 });
  writeFileSync(join(hooks, PRESERVED_HOOK), '#!/bin/sh\n# older theirs\n', { mode: 0o755 });
  assert.throws(() => installPostCommitHook(repo.path, '/nonexistent/eyes-on'), /already exists/);
  assert.ok(readFileSync(join(hooks, 'post-commit'), 'utf8').includes('# theirs'));
});
