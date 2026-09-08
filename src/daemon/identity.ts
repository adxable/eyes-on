import { spawnSync } from 'node:child_process';
import type { Paths } from '../core/paths.js';
import type { LockHolder } from './lock.js';

/**
 * Whether the process named by the lock record really is this root's daemon.
 *
 * A pid is not an identity. The kernel reuses the number as soon as the process
 * that had it is reaped, so `daemon.pid` naming a live pid proves only that
 * *something* is running - and signalling on that alone would eventually send
 * SIGTERM to whatever inherited the number. Everything eyes-on may signal goes
 * through `identifyDaemonProcess` first, and a reading that does not confirm
 * the process is a refusal to signal, never a reason to guess.
 *
 * Two independent facts have to agree, because either one alone is satisfiable
 * by a recycled pid:
 *
 *   - the command line has to be an eyes-on daemon serving *this* state root.
 *     `daemon run --root <root>` is how the daemon is invoked from all three
 *     places that start one - the LaunchAgent, the systemd unit and the
 *     detached spawn in `startDaemon` - so a process that is not running it, or
 *     is running it for another root, is not the holder this run may end;
 *   - the process cannot have started after the record naming it was written.
 *     The daemon writes `daemon.pid` immediately after taking the lock, so its
 *     mtime - the `startedAt` of the holder record `inspectLock` returns - is
 *     at or after the moment the process started. A later start time is the
 *     signature of the recycled pid: the number in the file outlived the
 *     process that wrote it.
 *
 * The command line is read with `/bin/ps`, the same system-binary exception the
 * plist reader takes (`service.ts`): there is no portable way to ask Node about
 * another process's argv, and a reading nobody can produce is reported as one
 * rather than assumed away.
 */

/** What the OS says about a process, in the two terms identity needs. */
export type ProcessReading =
  | { kind: 'facts'; commandLine: string; startedAt: number | null }
  /** `ps` answered, and no process has this pid. */
  | { kind: 'gone' }
  /** `ps` could not be run or could not be parsed - not a verdict either way. */
  | { kind: 'unreadable'; detail: string };

/** Injected in tests, so a staged reading needs no staged process. */
export type ProcessReader = (pid: number) => ProcessReading;

export type Identity =
  | { confirmed: true; commandLine: string }
  | { confirmed: false; reason: string };

/** `ps` lives here on macOS and on every Linux this runs on; `/usr/bin/ps` is
 *  the fallback for a distribution that has not merged `/bin`. */
const PS_BINARIES = ['/bin/ps', '/usr/bin/ps'] as const;

/** `Tue Sep  8 13:46:16 2026`, the `lstart` format on both platforms. */
const LSTART = /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

export function readProcess(pid: number): ProcessReading {
  let lastDetail = 'ps could not be run';
  for (const binary of PS_BINARIES) {
    const result = spawnSync(binary, ['-p', String(pid), '-o', 'lstart=', '-o', 'args='], {
      encoding: 'utf8',
      timeout: 10_000,
      // `lstart` is `%a %b %e %H:%M:%S %Y` rendered in the caller's locale, and
      // `Date.parse` reads English month and day names only. Under `LC_TIME=pl_PL`
      // the same process prints `pon wrz  8 13:46:16 2026`, which parses to NaN -
      // no start time, no confirmation, and a daemon this machine could never
      // stop. The locale is pinned to the one the parser is written for.
      env: { ...process.env, LC_ALL: 'C' },
    });
    if (result.error) {
      lastDetail = String((result.error as Error).message ?? result.error);
      continue;
    }
    const line = (result.stdout ?? '').split('\n').find((entry) => entry.trim().length > 0);
    // ps exits non-zero with no output when the pid does not exist, which is an
    // answer rather than a failure.
    if (!line) return { kind: 'gone' };
    const match = LSTART.exec(line.trim());
    if (!match) return { kind: 'facts', commandLine: line.trim(), startedAt: null };
    const parsed = Date.parse(match[1] as string);
    return {
      kind: 'facts',
      commandLine: (match[2] as string).trim(),
      startedAt: Number.isFinite(parsed) ? parsed : null,
    };
  }
  return { kind: 'unreadable', detail: lastDetail };
}

/** The command line reads as `... daemon run ...`. */
function runsDaemon(commandLine: string): boolean {
  return /(^|\s)daemon\s+run(\s|$)/.test(commandLine);
}

/**
 * The command line names this state root as the `--root` it serves.
 *
 * The comparison is on the whole path rather than on whitespace-split tokens:
 * `ps` joins argv with spaces, so a root that contains one cannot be recovered
 * by splitting - and this repository already carries a state root with a space
 * in its tests.
 */
function namesRoot(commandLine: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    for (const form of [`--root ${root}`, `--root=${root}`]) {
      let at = commandLine.indexOf(form);
      while (at >= 0) {
        const before = at === 0 ? ' ' : (commandLine[at - 1] as string);
        const after = commandLine[at + form.length] ?? ' ';
        if (/\s/.test(before) && /\s/.test(after)) return true;
        at = commandLine.indexOf(form, at + 1);
      }
    }
  }
  return false;
}

/** Long command lines are quoted back in a message, so they are bounded. */
function short(commandLine: string): string {
  return commandLine.length > 160 ? `${commandLine.slice(0, 157)}...` : commandLine;
}

/**
 * A start time later than the record is a reused pid; the slack absorbs
 * `lstart`'s one-second resolution and a filesystem timestamp written a moment
 * after the process began.
 */
const START_SLACK_MS = 2000;

/**
 * Decides whether `pid` may be signalled as the daemon of `paths`.
 *
 * `holder` is the record the lock produced - the pid and the moment it was
 * recorded - and not a number a caller looked up separately: the whole point is
 * that the check is made against the record rather than against the pid alone.
 */
export function identifyDaemonProcess(
  paths: Paths,
  holder: LockHolder,
  read: ProcessReader = readProcess,
): Identity {
  const reading = read(holder.pid);
  if (reading.kind === 'gone') {
    return { confirmed: false, reason: `pid ${holder.pid} is no longer running` };
  }
  if (reading.kind === 'unreadable') {
    return {
      confirmed: false,
      reason: `this run could not read what pid ${holder.pid} is (${reading.detail})`,
    };
  }
  if (!runsDaemon(reading.commandLine)) {
    return {
      confirmed: false,
      reason: `pid ${holder.pid} is not running an eyes-on daemon (its command line is \`${short(reading.commandLine)}\`)`,
    };
  }
  if (!namesRoot(reading.commandLine, [paths.root, paths.canonicalRoot()])) {
    return {
      confirmed: false,
      reason: `pid ${holder.pid} runs a daemon whose command line does not name ${paths.root} (it is \`${short(reading.commandLine)}\`)`,
    };
  }
  if (reading.startedAt === null) {
    return { confirmed: false, reason: `this run could not read when pid ${holder.pid} started` };
  }
  if (reading.startedAt > holder.startedAt + START_SLACK_MS) {
    return {
      confirmed: false,
      reason:
        `pid ${holder.pid} started at ${new Date(reading.startedAt).toISOString()}, after the record naming it was ` +
        `written at ${new Date(holder.startedAt).toISOString()}: that pid has been reused by another process`,
    };
  }
  return { confirmed: true, commandLine: reading.commandLine };
}
