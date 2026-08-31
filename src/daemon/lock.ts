import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The singleton: an exclusive, kernel-held lock on `daemon.lock`, taken before
 * anything else the daemon does and held for the process's whole life
 * (report M13).
 *
 * Node exposes no flock(2), and a "lock file" made of open(O_EXCL) plus a pid
 * check is not a lock - it is a race with a liveness heuristic bolted on, and
 * it survives neither SIGKILL nor a pid recycled by the OS. So the lock is a
 * SQLite database opened in `locking_mode=EXCLUSIVE`: the first write takes a
 * POSIX fcntl lock on the file and holds it until the connection closes, a
 * second process gets SQLITE_BUSY, and the kernel releases the lock when the
 * holder dies for any reason at all. Both properties are verified in
 * test/lock.test.ts, including release after SIGKILL.
 *
 * That the lock file happens to be a SQLite database is an implementation
 * detail with one deliberate benefit: it carries the holder's pid and start
 * time, so a rejected second daemon can name the live one instead of saying
 * "busy". The visible cost is a `daemon.lock-journal` file that sits next to it
 * for as long as the lock is held - in exclusive locking mode SQLite keeps the
 * rollback journal rather than deleting it on commit. It is transient state, it
 * disappears with the daemon, and the journal is kept rather than disabled so a
 * crash mid-write cannot leave a lock file too corrupt to open.
 *
 * Order matters as much as the mechanism. The lock is taken *before* the IPC
 * socket is bound (internal/daemon/daemon.go:169-186), so two daemons can never
 * both reach the point of touching shared state.
 */

export interface LockHolder {
  pid: number;
  startedAt: number;
}

export class LockHeldError extends Error {
  readonly holder: LockHolder | null;
  constructor(path: string, holder: LockHolder | null) {
    const who = holder ? ` (pid ${holder.pid}, started ${new Date(holder.startedAt).toISOString()})` : '';
    super(`an eyes-on daemon already holds ${path}${who}`);
    this.name = 'LockHeldError';
    this.holder = holder;
  }
}

export class SingletonLock {
  private handle: DatabaseSync | null;
  readonly path: string;

  private constructor(handle: DatabaseSync, path: string) {
    this.handle = handle;
    this.path = path;
  }

  /** Takes the lock, or throws LockHeldError naming the live holder. */
  static acquire(path: string): SingletonLock {
    mkdirSync(dirname(path), { recursive: true });
    const handle = new DatabaseSync(path);
    try {
      handle.exec('PRAGMA locking_mode = EXCLUSIVE');
      handle.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL, started_at INTEGER NOT NULL)');
      handle.exec('DELETE FROM holder');
      handle.prepare('INSERT INTO holder (pid, started_at) VALUES (?, ?)').run(process.pid, Date.now());
    } catch (error) {
      const holder = SingletonLock.readHolder(path);
      try {
        handle.close();
      } catch {
        // Closing a handle that never took the lock cannot fail usefully.
      }
      if (/locked|busy/i.test((error as Error).message ?? '')) {
        throw new LockHeldError(path, holder);
      }
      throw error;
    }
    return new SingletonLock(handle, path);
  }

  /** Best-effort read of the diagnostic record. Returns null if the file is
   *  locked, absent, or not the shape we wrote - the caller then reports a
   *  generic "already running". */
  static readHolder(path: string): LockHolder | null {
    try {
      const reader = new DatabaseSync(path, { readOnly: true });
      try {
        const row = reader.prepare('SELECT pid, started_at FROM holder LIMIT 1').get() as
          | { pid: number; started_at: number }
          | undefined;
        return row ? { pid: row.pid, startedAt: row.started_at } : null;
      } finally {
        reader.close();
      }
    } catch {
      return null;
    }
  }

  release(): void {
    if (!this.handle) return;
    try {
      this.handle.close();
    } catch {
      // The kernel drops the lock on close or on exit either way.
    }
    this.handle = null;
  }
}
