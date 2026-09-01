import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Byte-bounded process log with a deterministic backup chain (report M26).
 *
 * no-mistakes bounds its logs at 32 MiB x 3 (internal/logstore/rotate.go:16-34);
 * eyes-on runs a much smaller workload - one assessment per head, no pipeline
 * transcripts - so 8 MiB x 2 is the adopted policy. The point of copying the
 * shape is that an unbounded daemon log on the captain's machine is a slow
 * disk leak nobody notices until it matters.
 *
 * Rotation renames the current file into the `.1 .. .N` chain and opens a fresh
 * one. Backups are numbered newest-first, so `daemon.log.1` is always the most
 * recent retired segment.
 *
 * The same bound has to reach three files this class does not own: the two
 * capture files a LaunchAgent opens (`logs/service.out.log`,
 * `logs/service.err.log`) and `logs/daemon.out.log` from the spawn fallback.
 * They carry whatever the daemon writes before its own logging exists - a stack
 * trace on every restart of a daemon that dies at start-up, with nothing to
 * truncate them - so `boundCaptureFile` and `rotateFileIfOversized` below apply
 * the policy to them too. Which of the two applies depends on who holds the
 * file open, and that difference is the whole reason there are two.
 */
export interface LogPolicy {
  maxBytes: number;
  backups: number;
}

export const DEFAULT_LOG_POLICY: LogPolicy = { maxBytes: 8 * 1024 * 1024, backups: 2 };

export class RotatingLog {
  private readonly path: string;
  private readonly policy: LogPolicy;
  private fd: number | null = null;
  private size = 0;

  constructor(path: string, policy: LogPolicy = DEFAULT_LOG_POLICY) {
    this.path = path;
    this.policy = policy;
  }

  private open(): number {
    if (this.fd !== null) return this.fd;
    mkdirSync(dirname(this.path), { recursive: true });
    this.fd = openSync(this.path, 'a');
    this.size = existsSync(this.path) ? statSync(this.path).size : 0;
    return this.fd;
  }

  /** Appends one line, rotating first when the line would cross the bound. */
  write(line: string): void {
    const payload = line.endsWith('\n') ? line : `${line}\n`;
    const bytes = Buffer.byteLength(payload);
    this.open();
    if (this.size > 0 && this.size + bytes > this.policy.maxBytes) {
      this.rotate();
    }
    writeSync(this.fd as number, payload);
    this.size += bytes;
  }

  /** Timestamped structured line, the only shape the daemon writes. */
  log(event: string, fields: Record<string, unknown> = {}): void {
    this.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  }

  /** Retires the current file without writing anything, for a caller bounding
   *  a log it is about to hand to another process. */
  rotateNow(): void {
    this.rotate();
  }

  private rotate(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    // Drop the oldest, then shift every backup down one slot.
    const oldest = `${this.path}.${this.policy.backups}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = this.policy.backups - 1; index >= 1; index -= 1) {
      const from = `${this.path}.${index}`;
      if (existsSync(from)) renameSync(from, `${this.path}.${index + 1}`);
    }
    if (this.policy.backups >= 1 && existsSync(this.path)) {
      renameSync(this.path, `${this.path}.1`);
    } else if (existsSync(this.path)) {
      unlinkSync(this.path);
    }
    this.size = 0;
    this.open();
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

/**
 * Bounds a file another process holds open, by truncating it in place.
 *
 * launchd opens `StandardOutPath` and `StandardErrorPath` itself and keeps the
 * descriptor for the life of the job, so renaming the file would leave the job
 * writing into the renamed inode and the bound would never bite again. A
 * descriptor opened `O_APPEND` follows the truncation - the next write lands at
 * offset 0 - so truncating is the form of the policy that actually holds here.
 * The cost is that the oldest capture is dropped rather than retired, which is
 * the right trade for a file whose content is a repeated crash trace.
 *
 * Returns true when the file was over the bound and has been emptied.
 */
export function boundCaptureFile(path: string, policy: LogPolicy = DEFAULT_LOG_POLICY): boolean {
  try {
    if (statSync(path).size <= policy.maxBytes) return false;
    truncateSync(path, 0);
    return true;
  } catch {
    // A capture file that does not exist yet, or that this process may not
    // touch, is not a reason to fail the daemon it belongs to.
    return false;
  }
}

/**
 * Bounds a file this process is about to open itself, by retiring it into the
 * same `.1 .. .N` chain `RotatingLog` uses. Unlike `boundCaptureFile` this
 * keeps the content, which is possible precisely because nothing holds the file
 * open across the rename.
 */
export function rotateFileIfOversized(path: string, policy: LogPolicy = DEFAULT_LOG_POLICY): boolean {
  try {
    if (statSync(path).size <= policy.maxBytes) return false;
  } catch {
    return false;
  }
  const log = new RotatingLog(path, policy);
  log.rotateNow();
  log.close();
  return true;
}
