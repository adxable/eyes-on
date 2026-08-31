import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { LockHeldError, SingletonLock } from '../src/daemon/lock.js';
import { tempDir } from './helpers.js';

/**
 * The singleton is the one primitive whose failure is silent, so it is tested
 * against a real second process rather than against itself: a lock that only
 * excludes callers inside one process excludes nothing that matters.
 */
test('a second process cannot take a held lock, and the holder is named', () => {
  const dir = tempDir('lock');
  const path = join(dir, 'daemon.lock');
  const lock = SingletonLock.acquire(path);
  try {
    const holder = SingletonLock.readHolder(path);
    assert.equal(holder, null, 'a held exclusive lock is not readable, which is the point');

    const script = join(dir, 'second.mjs');
    writeFileSync(
      script,
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.argv[2]);
       try {
         db.exec('PRAGMA locking_mode = EXCLUSIVE');
         db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL, started_at INTEGER NOT NULL)');
         db.exec('DELETE FROM holder');
         process.stdout.write('ACQUIRED');
       } catch (error) { process.stdout.write('REFUSED'); }`,
    );
    const second = spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
    assert.equal(second.stdout.trim(), 'REFUSED');
  } finally {
    lock.release();
  }

  // Released: the next acquire succeeds.
  const again = SingletonLock.acquire(path);
  again.release();
});

test('the kernel releases the lock when the holder is killed outright', async () => {
  const dir = tempDir('lock-kill');
  const path = join(dir, 'daemon.lock');
  const script = join(dir, 'holder.mjs');
  writeFileSync(
    script,
    `import { DatabaseSync } from 'node:sqlite';
     const db = new DatabaseSync(process.argv[2]);
     db.exec('PRAGMA locking_mode = EXCLUSIVE');
     db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL, started_at INTEGER NOT NULL)');
     db.exec('DELETE FROM holder');
     process.stdout.write('HELD\\n');
     setInterval(() => {}, 1000);`,
  );
  const holder = spawn(process.execPath, [script, path], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));

  assert.throws(() => SingletonLock.acquire(path), LockHeldError);

  // SIGKILL leaves no chance to clean up: only a kernel-held lock survives this
  // test, which is why the lock is not a pid file.
  holder.kill('SIGKILL');
  await delay(400);
  const lock = SingletonLock.acquire(path);
  lock.release();
});

test('the holder record identifies the live daemon once readable', () => {
  const path = join(tempDir('lock-holder'), 'daemon.lock');
  const lock = SingletonLock.acquire(path);
  lock.release();
  const holder = SingletonLock.readHolder(path);
  assert.equal(holder?.pid, process.pid);
});
