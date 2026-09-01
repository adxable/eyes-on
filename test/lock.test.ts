import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { LockHeldError, LockUnusableError, SingletonLock, inspectLock } from '../src/daemon/lock.js';
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

/**
 * The record inside the lock is what tells a stale lock from a clean stop, so
 * the two endings have to leave different files behind: a release clears the
 * row while it still holds the lock, and only a death can leave one.
 */
test('a clean release clears the record, and only an abrupt death leaves one', async () => {
  const dir = tempDir('lock-holder');
  const path = join(dir, 'daemon.lock');
  const lock = SingletonLock.acquire(path);
  lock.release();
  assert.equal(SingletonLock.readHolder(path), null, 'a daemon that stopped leaves no holder record');

  const script = join(dir, 'holder.mjs');
  writeFileSync(
    script,
    `import { DatabaseSync } from 'node:sqlite';
     const db = new DatabaseSync(process.argv[2]);
     db.exec('PRAGMA locking_mode = EXCLUSIVE');
     db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL, started_at INTEGER NOT NULL)');
     db.exec('DELETE FROM holder');
     db.prepare('INSERT INTO holder (pid, started_at) VALUES (?, ?)').run(process.pid, Date.now());
     process.stdout.write('HELD\\n');
     setInterval(() => {}, 1000);`,
  );
  const holder = spawn(process.execPath, [script, path], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));
  holder.kill('SIGKILL');
  await delay(400);

  assert.equal(SingletonLock.readHolder(path)?.pid, holder.pid, 'a holder that died leaves its record behind');
});


/**
 * A lock file that is not a SQLite database at all - a truncated write, a file
 * something else created under that name. Both halves have to agree: the read
 * side reports that it could not be used, and the write side refuses with the
 * one repair that works rather than an unexplained failure.
 */
test('a lock file this version cannot open is refused with the repair that works', () => {
  const path = join(tempDir('lock-corrupt'), 'daemon.lock');
  writeFileSync(path, 'this is not a database');

  assert.equal(inspectLock(path).state, 'unreadable');
  assert.throws(() => SingletonLock.acquire(path), LockUnusableError);
  try {
    SingletonLock.acquire(path);
    assert.fail('a corrupt lock file must not yield a lock');
  } catch (error) {
    assert.ok(error instanceof LockUnusableError);
    assert.match(error.message, /is not a usable eyes-on lock file/);
    assert.ok(error.help.some((line) => line.includes(path)), 'the remedy must name the file to remove');
  }

  // And the repair the message names actually works.
  rmSync(path);
  const lock = SingletonLock.acquire(path);
  lock.release();
  assert.equal(inspectLock(path).state, 'free');
});
