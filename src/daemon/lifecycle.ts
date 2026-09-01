import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Paths } from '../core/paths.js';
import { Daemon } from './daemon.js';
import { SingletonLock, type LockHolder } from './lock.js';
import { startManagedJob, type ManagedJobStart } from './service.js';
import { call, DaemonUnreachableError } from '../ipc/client.js';
import { METHODS, type HealthResult, type StatusResult } from '../ipc/protocol.js';
import { probeSocket } from '../ipc/server.js';

/**
 * Starting, stopping and reporting on the daemon from a CLI process.
 *
 * Liveness is answered by asking the daemon, never by trusting a pid file: the
 * pid file is a record a live daemon writes for humans, the lock is what makes
 * the daemon single, and the socket is what proves it is listening. A stale pid
 * file is a diagnostic, not a verdict.
 */

export interface DaemonState {
  running: boolean;
  pid: number | null;
  root: string;
  version: string | null;
  uptimeSeconds: number | null;
  /** Lock holder when the daemon is not answering but the lock is taken - the
   *  shape of a wedged process, worth telling the user about. */
  lockHolder: LockHolder | null;
  socketPresent: boolean;
}

export async function daemonState(paths: Paths): Promise<DaemonState> {
  const socketPresent = existsSync(paths.socket);
  try {
    const health = await call<HealthResult>(paths.socket, METHODS.health, {}, 3000);
    return {
      running: true,
      pid: health.pid,
      root: health.root,
      version: health.version,
      uptimeSeconds: Math.floor((Date.now() - health.startedAt) / 1000),
      lockHolder: null,
      socketPresent,
    };
  } catch (error) {
    if (!(error instanceof DaemonUnreachableError)) throw error;
    return {
      running: false,
      pid: readPidFile(paths),
      root: paths.root,
      version: null,
      uptimeSeconds: null,
      lockHolder: SingletonLock.readHolder(paths.lockFile),
      socketPresent,
    };
  }
}

function readPidFile(paths: Paths): number | null {
  try {
    const value = Number.parseInt(readFileSync(paths.pidFile, 'utf8').trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Absolute path of the CLI entry module, used when re-spawning ourselves. */
export function cliEntryPath(): string {
  // dist/src/daemon -> dist/src/cli/main.js
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'main.js');
}

/** Polls until the daemon answers, or the deadline passes. Used after handing
 *  the daemon to an OS service manager, which starts it out of band. */
export async function waitForDaemon(paths: Paths, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await daemonState(paths)).running) return true;
    if (Date.now() >= deadline) return false;
    await delay(120);
  }
}

export interface StartResult {
  started: boolean;
  alreadyRunning: boolean;
  pid: number | null;
  /** How the daemon was obtained, so a caller never has to guess. */
  via: 'already-running' | 'service' | 'spawn';
  /** Why the service manager could not supply one, when it could not. */
  detail: string | null;
}

export interface StartDaemonOptions {
  timeoutMs?: number;
  /**
   * Overridden in tests so the managed-job branch can be exercised without
   * registering a real LaunchAgent or systemd unit.
   */
  startManagedJob?: (paths: Paths) => ManagedJobStart;
}

/**
 * The one way to obtain a daemon.
 *
 * When a service manager holds a job for this root, that job is started and
 * waited for, and a failure there is reported rather than routed around:
 * spawning *beside* a held job is the orphan split this product has had to fix
 * three times. The detached spawn is the fallback for every case where nothing
 * is held and so nothing can be orphaned - `EYES_ON_SKIP_SERVICE_MANAGER=1`, an
 * unsupported platform, no unit file, or a service manager that cannot be
 * reached at all (a host with no systemd user bus, a launchd domain this
 * session cannot address). That last case is why the fallback keys on what the
 * manager holds rather than on a unit file existing: `installService` writes the
 * file before it tries to load it. Whether a managed service is *wanted* is
 * `init`'s decision, taken by removing the job; this path only asks what is
 * there.
 *
 * The spawn is detached and with its own stdio, so the daemon outlives the CLI
 * process that asked for it - and with cwd set to the state root, never to a
 * repository, so no eyes-on process ever has a working directory under somebody
 * else's worktree (report K9, M23).
 */
export async function startDaemon(paths: Paths, options: StartDaemonOptions = {}): Promise<StartResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const state = await daemonState(paths);
  if (state.running) {
    return { started: false, alreadyRunning: true, pid: state.pid, via: 'already-running', detail: null };
  }

  Daemon.ensureStateRoot(paths);

  const managed = (options.startManagedJob ?? startManagedJob)(paths);
  if (managed.outcome === 'started') {
    if (await waitForDaemon(paths, timeoutMs)) {
      const current = await daemonState(paths);
      return { started: true, alreadyRunning: false, pid: current.pid, via: 'service', detail: null };
    }
    return {
      started: false,
      alreadyRunning: false,
      pid: null,
      via: 'service',
      detail: `the managed job ${managed.label} was started but did not answer`,
    };
  }
  if (managed.outcome === 'refused') {
    return {
      started: false,
      alreadyRunning: false,
      pid: null,
      via: 'service',
      detail: managed.detail ?? `the managed job ${managed.label} would not start`,
    };
  }

  const logFd = openSync(join(paths.logsDir, 'daemon.out.log'), 'a');
  const child = spawn(process.execPath, [cliEntryPath(), 'daemon', 'run', '--root', paths.root], {
    cwd: paths.root,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, EYES_HOME: paths.root },
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(120);
    const current = await daemonState(paths);
    if (current.running) {
      return { started: true, alreadyRunning: false, pid: current.pid, via: 'spawn', detail: null };
    }
  }
  return { started: false, alreadyRunning: false, pid: null, via: 'spawn', detail: 'the spawned daemon did not answer' };
}

export interface StopResult {
  stopped: boolean;
  wasRunning: boolean;
}

/** Asks the daemon to exit, escalating to a signal only if it does not. */
export async function stopDaemon(paths: Paths, timeoutMs = 10_000): Promise<StopResult> {
  const state = await daemonState(paths);
  if (!state.running) {
    // A socket file with nothing behind it is debris from an unclean exit and
    // is safe to remove precisely because nothing answered on it.
    if (state.socketPresent && !(await probeSocket(paths.socket))) {
      rmSync(paths.socket, { force: true });
    }
    return { stopped: false, wasRunning: false };
  }
  try {
    await call(paths.socket, METHODS.shutdown, {}, 3000);
  } catch {
    // A daemon that drops the connection while exiting is a success, not an
    // error; the wait below decides.
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(100);
    if (!(await daemonState(paths)).running) return { stopped: true, wasRunning: true };
  }
  if (state.pid) {
    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      // The process may have exited between the check and the signal.
    }
  }
  await delay(500);
  return { stopped: !(await daemonState(paths)).running, wasRunning: true };
}

/**
 * Stop, then start through the same single path. `stopDaemon` asks a managed
 * daemon to exit and it exits 0, which leaves the job loaded with no process -
 * so the start half must address that job rather than spawn beside it.
 */
export async function restartDaemon(paths: Paths, options: StartDaemonOptions = {}): Promise<StartResult> {
  await stopDaemon(paths);
  return startDaemon(paths, options);
}

export async function daemonStatus(paths: Paths): Promise<StatusResult | null> {
  try {
    return await call<StatusResult>(paths.socket, METHODS.status, {}, 5000);
  } catch (error) {
    if (error instanceof DaemonUnreachableError) return null;
    throw error;
  }
}
