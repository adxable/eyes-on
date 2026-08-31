import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
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
