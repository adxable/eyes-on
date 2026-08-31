import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Paths } from '../core/paths.js';
import { Daemon } from './daemon.js';
import { SingletonLock, type LockHolder } from './lock.js';
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
}

/**
 * Starts a detached daemon and waits for it to answer. Detached and with its
 * own stdio, so the daemon outlives the CLI process that asked for it - and
 * with cwd set to the state root, never to a repository, so no eyes-on process
 * ever has a working directory under somebody else's worktree (report K9, M23).
 */
export async function startDaemon(paths: Paths, timeoutMs = 15_000): Promise<StartResult> {
  const state = await daemonState(paths);
  if (state.running) return { started: false, alreadyRunning: true, pid: state.pid };

  Daemon.ensureStateRoot(paths);
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
    if (current.running) return { started: true, alreadyRunning: false, pid: current.pid };
  }
  return { started: false, alreadyRunning: false, pid: null };
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

export async function restartDaemon(paths: Paths): Promise<StartResult> {
  await stopDaemon(paths);
  return startDaemon(paths);
}

export async function daemonStatus(paths: Paths): Promise<StatusResult | null> {
  try {
    return await call<StatusResult>(paths.socket, METHODS.status, {}, 5000);
  } catch (error) {
    if (error instanceof DaemonUnreachableError) return null;
    throw error;
  }
}
