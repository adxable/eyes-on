import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { ensureMirror, inspectMirror, mirrorSizeBytes } from '../src/git/mirror.js';
import { tempDir, tempRepo, run } from './helpers.js';

test('the mirror borrows objects through alternates instead of copying them', () => {
  const repo = tempRepo('mirror-src');
  const mirrorPath = join(tempDir('mirror'), 'repo.git');

  const result = ensureMirror(mirrorPath, repo.path);
  assert.equal(result.created, true);
  assert.equal(result.status.refs, 1);

  const alternates = readFileSync(join(mirrorPath, 'objects', 'info', 'alternates'), 'utf8').trim();
  assert.equal(alternates, join(repo.path, '.git', 'objects'));
  assert.equal(result.status.alternateReachable, true);

  // The clone's own objects are not duplicated into the mirror.
  const packedInMirror = run(mirrorPath, ['--git-dir', mirrorPath, 'count-objects', '-v']);
  assert.match(packedInMirror, /count: 0|in-pack: 0/);
});

test('history is readable through the mirror, which is why it can be borrowed', () => {
  const repo = tempRepo('mirror-read');
  repo.commit('second');
  const mirrorPath = join(tempDir('mirror-read-dst'), 'repo.git');
  ensureMirror(mirrorPath, repo.path);

  const log = run(mirrorPath, ['--git-dir', mirrorPath, 'log', '--oneline', 'refs/remotes/clone/main']);
  assert.equal(log.trim().split('\n').length, 2);
  const blame = run(mirrorPath, ['--git-dir', mirrorPath, 'blame', '--line-porcelain', 'refs/remotes/clone/main', '--', 'file.txt']);
  assert.match(blame, /author eyes-on tests/);
});

test('ensureMirror is idempotent and picks up new commits incrementally', () => {
  const repo = tempRepo('mirror-idem');
  const mirrorPath = join(tempDir('mirror-idem-dst'), 'repo.git');
  const first = ensureMirror(mirrorPath, repo.path);
  assert.equal(first.created, true);

  const second = ensureMirror(mirrorPath, repo.path);
  assert.equal(second.created, false);
  assert.equal(second.repaired, false);
  assert.equal(second.status.refs, 1);

  repo.commit('third');
  ensureMirror(mirrorPath, repo.path);
  const log = run(mirrorPath, ['--git-dir', mirrorPath, 'log', '--oneline', 'refs/remotes/clone/main']);
  assert.equal(log.trim().split('\n').length, 2);
});

test('reading a clone into a mirror leaves the clone byte-identical', () => {
  const repo = tempRepo('mirror-untouched');
  const statusBefore = run(repo.path, ['status', '--porcelain']);
  const refsBefore = run(repo.path, ['for-each-ref']);
  const configBefore = readFileSync(join(repo.path, '.git', 'config'), 'utf8');

  const mirrorPath = join(tempDir('mirror-untouched-dst'), 'repo.git');
  ensureMirror(mirrorPath, repo.path);
  ensureMirror(mirrorPath, repo.path);

  assert.equal(run(repo.path, ['status', '--porcelain']), statusBefore);
  assert.equal(run(repo.path, ['for-each-ref']), refsBefore);
  assert.equal(readFileSync(join(repo.path, '.git', 'config'), 'utf8'), configBefore);
});

test('a mirror whose clone is gone reports itself broken rather than pretending', () => {
  const repo = tempRepo('mirror-orphan');
  const mirrorPath = join(tempDir('mirror-orphan-dst'), 'repo.git');
  ensureMirror(mirrorPath, repo.path);
  rmSync(repo.path, { recursive: true, force: true });

  const status = inspectMirror(mirrorPath);
  assert.equal(status.exists, true);
  assert.equal(status.alternateReachable, false, 'a mirror is a rebuildable cache, not state');
});

test('the mirror is small: it holds refs, not a copy of the repository', () => {
  const repo = tempRepo('mirror-size');
  for (let index = 0; index < 20; index += 1) {
    repo.commit(`commit ${index}`, 'file.txt', 'x'.repeat(4096) + index);
  }
  const mirrorPath = join(tempDir('mirror-size-dst'), 'repo.git');
  ensureMirror(mirrorPath, repo.path);
  assert.ok(mirrorSizeBytes(mirrorPath) < 5 * 1024 * 1024, 'the mirror stays far under the 5 MB budget');
});
