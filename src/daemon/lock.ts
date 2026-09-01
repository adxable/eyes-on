import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
 * That the lock file happens to be a SQLite database has one consequence worth
 * stating precisely, because it is easy to get backwards: the holder row is
 * readable only while nobody holds the lock. A second connection opened against
 * a held lock fails the first read with "database is locked", so a row that can
 * be read is a record of a *past* holder, not a live one. `inspectLock` is
 * written around that fact - an unreadable file means the lock is held, a
 * readable row means it is free and somebody left a record behind - and it is
 * the only place allowed to turn the read into a claim about a process. The
 * visible cost is a `daemon.lock-journal` file that sits next to the lock for as
 * long as it is held - in exclusive locking mode SQLite keeps the rollback
 * journal rather than deleting it on commit. It is transient state, it
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
  /** The live holder when this process could name one, which it can only do
   *  from a pid file: the holder row inside a held lock is unreadable. */
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
      // Not `readHolder`: the lock we just failed to take is held, so its row
      // cannot be read. The live holder, if anyone can name it, comes from the
      // pid file the daemon writes next to it.
      const holder = livePidFileHolder(path);
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

  /** Best-effort read of the record left by the last acquirer. Returns null
   *  while the lock is held - the read is refused - and null when the file is
   *  absent or not the shape we wrote. Callers that need to tell those apart
   *  use `inspectLock`. */
  static readHolder(path: string): LockHolder | null {
    const read = readHolderRow(path);
    return read.kind === 'holder' ? read.holder : null;
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

type HolderRead =
  | { kind: 'holder'; holder: LockHolder }
  | { kind: 'empty' }
  | { kind: 'locked'; detail: string }
  | { kind: 'unreadable'; detail: string };

function classifyReadFailure(error: unknown): HolderRead {
  const detail = (error as Error).message ?? 'the lock file could not be read';
  // SQLite answers "database is locked" for a file another connection holds in
  // exclusive locking mode, and "no such table: holder" for one nobody has
  // written a record into yet - a lock file that exists but is not held.
  if (/locked|busy/i.test(detail)) return { kind: 'locked', detail };
  if (/no such table/i.test(detail)) return { kind: 'empty' };
  return { kind: 'unreadable', detail };
}

function readHolderRow(path: string): HolderRead {
  let reader: DatabaseSync;
  try {
    reader = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    return classifyReadFailure(error);
  }
  try {
    const row = reader.prepare('SELECT pid, started_at FROM holder LIMIT 1').get() as
      | { pid: number; started_at: number }
      | undefined;
    return row ? { kind: 'holder', holder: { pid: row.pid, startedAt: row.started_at } } : { kind: 'empty' };
  } catch (error) {
    return classifyReadFailure(error);
  } finally {
    reader.close();
  }
}

/** True when a process with this pid exists, whoever owns it. */
export function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to somebody else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The live pid recorded in `daemon.pid` next to this lock file, if any. */
function livePidFileHolder(lockPath: string): LockHolder | null {
  try {
    const raw = readFileSync(join(dirname(lockPath), 'daemon.pid'), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!processAlive(pid)) return null;
    return { pid, startedAt: statSync(join(dirname(lockPath), 'daemon.pid')).mtimeMs };
  } catch {
    return null;
  }
}

export type LockState =
  /** No lock file, or one nobody has ever taken. */
  | 'free'
  /** A live process holds it: the record inside is unreadable, which is how we
   *  know. */
  | 'held'
  /** Not held, and a record from an earlier holder is still inside. */
  | 'stale'
  /** Present, not held, and not a lock file this version can read. */
  | 'unreadable';

export interface LockInspection {
  state: LockState;
  /** The record left behind, readable only when the lock is *not* held. */
  staleHolder: LockHolder | null;
  /** The live holder, when a pid file next to the lock names one. */
  liveHolder: LockHolder | null;
  detail: string | null;
}

/**
 * What the singleton lock says right now, in terms of the process that holds
 * it rather than of the row that can be read.
 *
 * The inversion this replaces is worth naming: reading the holder row and
 * calling its pid "the holder" reports a dead process as live and reports a
 * live, wedged daemon as nothing at all, because those two cases produce
 * exactly the opposite readings.
 */
export function inspectLock(path: string): LockInspection {
  if (!existsSync(path)) {
    return { state: 'free', staleHolder: null, liveHolder: null, detail: null };
  }
  const read = readHolderRow(path);
  switch (read.kind) {
    case 'locked':
      return { state: 'held', staleHolder: null, liveHolder: livePidFileHolder(path), detail: read.detail };
    case 'holder':
      return { state: 'stale', staleHolder: read.holder, liveHolder: null, detail: null };
    case 'empty':
      return { state: 'free', staleHolder: null, liveHolder: null, detail: null };
    case 'unreadable':
      return { state: 'unreadable', staleHolder: null, liveHolder: null, detail: read.detail };
  }
}
