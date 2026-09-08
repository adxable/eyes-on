import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Paths } from '../core/paths.js';
import { logPolicy } from '../core/config.js';
import { rotateFileIfOversized } from '../core/logstore.js';
import { Daemon } from './daemon.js';
import { clearHolderRecord, inspectLock, processAlive, type LockHolder, type LockInspection } from './lock.js';
import { identifyDaemonProcess, readProcess, type ProcessReader } from './identity.js';
import {
  inspectService,
  serviceManagerBypassed,
  startManagedJob,
  type ManagedJobStart,
  type ServiceStatus,
} from './service.js';
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

/**
 * What the daemon is doing, in the terms a message may use.
 *
 * `wedged` and `stale-lock` are the two cases the lock can distinguish and the
 * two that used to be reported as each other: a live process holding the lock
 * while the socket stays silent is a daemon that needs stopping, and a readable
 * holder record is a lock nobody holds with a dead process's pid still in it.
 */
export type DaemonDiagnosis =
  | { kind: 'running'; pid: number | null }
  | { kind: 'wedged'; pid: number | null }
  | { kind: 'stale-lock'; pid: number }
  | { kind: 'lock-unreadable'; detail: string }
  | { kind: 'stopped' };

export interface DaemonState {
  running: boolean;
  pid: number | null;
  root: string;
  version: string | null;
  uptimeSeconds: number | null;
  /** The lock as it reads right now, or null while the daemon answers - a
   *  daemon that responds holds its own lock and nothing needs inspecting. */
  lock: LockInspection | null;
  /** The condition actually detected, which is what every message renders. */
  diagnosis: DaemonDiagnosis;
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
      lock: null,
      diagnosis: { kind: 'running', pid: health.pid },
      socketPresent,
    };
  } catch (error) {
    if (!(error instanceof DaemonUnreachableError)) throw error;
    const pid = readPidFile(paths);
    const lock = inspectLock(paths.lockFile);
    return {
      running: false,
      pid,
      root: paths.root,
      version: null,
      uptimeSeconds: null,
      lock,
      diagnosis: diagnose(lock),
      socketPresent,
    };
  }
}

/** Turns a lock reading into the one condition to report. */
function diagnose(lock: LockInspection): DaemonDiagnosis {
  switch (lock.state) {
    case 'held':
      // Somebody holds the lock while the socket stays silent. `inspectLock` is
      // the single reader of `daemon.pid` here, and it only reports a pid whose
      // process is alive, so a recycled or stale number is never named.
      return { kind: 'wedged', pid: lock.liveHolder?.pid ?? null };
    case 'stale':
      return { kind: 'stale-lock', pid: lock.staleHolder?.pid ?? 0 };
    case 'unreadable':
      return { kind: 'lock-unreadable', detail: lock.detail ?? 'the lock file could not be read' };
    case 'free':
      return { kind: 'stopped' };
  }
}

/**
 * The one sentence every surface uses for a daemon state, so `doctor` and
 * `daemon status` can never describe the same machine differently.
 */
export function describeDaemon(state: DaemonState, lockPath: string): string {
  switch (state.diagnosis.kind) {
    case 'running':
      return `running (pid ${state.diagnosis.pid}, up ${state.uptimeSeconds}s)`;
    case 'wedged':
      // Only what is known - a live process holds the lock, nothing answers the
      // socket - and a remedy that works in this state. `eyes-on daemon stop`
      // is one when the holder can be named: it signals that process after
      // confirming what it is. With no pid to name, nothing eyes-on can do
      // reaches the holder, so the sentence still sends the reader elsewhere.
      return state.diagnosis.pid === null
        ? `not answering, and ${lockPath} is held by a process this run could not identify - end it, or restart the eyes-on job through your service manager, before starting another daemon`
        : `not answering, and pid ${state.diagnosis.pid} is alive and still holds ${lockPath} - end it with \`eyes-on daemon stop\`, which signals that process, or with \`eyes-on daemon stop --force\` if it does not exit`;
    case 'stale-lock':
      return `stopped (${lockPath} is free; a record left by pid ${state.diagnosis.pid} remains in it)`;
    case 'lock-unreadable':
      // No daemon can start until this file is gone, so the sentence says so
      // rather than reading as an ordinary stopped daemon.
      return `stopped, and ${lockPath} is not a usable lock file (${state.diagnosis.detail}) - remove it while no daemon is running and it will be recreated`;
    case 'stopped':
      return 'stopped (run `eyes-on daemon start`)';
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

  // Whatever the spawned daemon writes before its own logging exists lands
  // here, so it carries the same bound as every other log in the root.
  const spawnLog = join(paths.logsDir, 'daemon.out.log');
  rotateFileIfOversized(spawnLog, logPolicy(paths));
  const logFd = openSync(spawnLog, 'a');
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

/** How a stop ended, in the terms every message and exit code renders. */
export type StopOutcome =
  /** Nothing was there to end. */
  | 'not-running'
  /** The daemon is gone and its lock is free. */
  | 'stopped'
  /** Something was asked or signalled and is still running. */
  | 'still-running'
  /** A wedged daemon survived SIGTERM and `--force` was not passed. */
  | 'needs-force'
  /** Nothing was signalled: the holder could not be confirmed to be this
   *  root's daemon, or this process may not signal it. */
  | 'refused'
  /** The wedged process ended, and something else holds the lock - so none of
   *  its state was cleaned up. */
  | 'lock-still-held'
  /**
   * This root has a daemon again, and it is not the process this call acted on:
   * the lock is held by a live process the identity gate confirms is this
   * root's daemon. That confirmation is the evidence - a job being loaded is
   * not, and a holder the gate cannot confirm is `lock-still-held`.
   */
  | 'replaced'
  /**
   * The lock is free, the process was ended with SIGKILL, and a service manager
   * holds this root's job. SIGKILL is the one exit this command can know was
   * unsuccessful, and an unsuccessful exit is exactly what
   * `KeepAlive.SuccessfulExit=false` and `Restart=on-failure` restart - so the
   * root is not reported as stopped for a daemon its manager brings back. A
   * daemon that took SIGTERM and exited cleanly is not this case: the job is
   * restarted on failure only, so that stop is a stop.
   */
  | 'service-managed';

export interface StopResult {
  stopped: boolean;
  /** True when a live process was found, whether it answered or was wedged. */
  wasRunning: boolean;
  outcome: StopOutcome;
  /** The pid this call acted on, when there was one. */
  pid: number | null;
  /** The last signal actually delivered, or null when none was. */
  signal: 'SIGTERM' | 'SIGKILL' | null;
  /** One sentence about anything other than an ordinary stop. */
  detail: string | null;
  /** What to do next, when there is something to do. */
  help: string[];
}

export interface StopDaemonOptions {
  timeoutMs?: number;
  /**
   * Escalate to SIGKILL when a wedged daemon does not exit on SIGTERM. Off by
   * default and never inferred: SIGKILL gives the daemon no chance to release
   * anything, so it is a thing a person asks for.
   */
  force?: boolean;
  /**
   * Overridden in tests, so a reading that cannot be staged with a real process
   * - a recycled pid, a `ps` that will not answer - can still be exercised.
   */
  readProcess?: ProcessReader;
  /**
   * Overridden in tests for the same reason: a loaded LaunchAgent or systemd
   * unit cannot be registered from a scratch state root.
   */
  inspectService?: (paths: Paths) => ServiceStatus;
}

/**
 * Asks the daemon to exit, escalating to a signal only if it does not.
 *
 * Two conditions end a daemon and they are not the same command. A daemon that
 * answers is asked over the socket and signalled only if the ask does not take.
 * A *wedged* one - a live process holding the lock while the socket says
 * nothing - can only be signalled. Both paths reach `signalHolder`, so every
 * signal eyes-on sends goes through `identifyDaemonProcess` first, against the
 * lock record read immediately beforehand: a pid is a number the kernel reuses,
 * so an unconfirmed holder is a refusal to signal rather than a signal sent on a
 * guess. Nothing the dead daemon leaves behind is removed before the process is
 * confirmed gone - the socket file of a live wedged daemon is the path it would
 * answer on again, and its lock file is a lock somebody holds.
 */
export async function stopDaemon(paths: Paths, options: StopDaemonOptions = {}): Promise<StopResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const state = await daemonState(paths);
  if (!state.running) {
    if (state.diagnosis.kind === 'wedged') {
      return stopWedgedDaemon(paths, state.lock?.liveHolder ?? null, timeoutMs, options);
    }
    // A socket file with nothing behind it is debris from an unclean exit and
    // is safe to remove precisely because nothing answered on it.
    if (state.socketPresent && !(await probeSocket(paths.socket))) {
      rmSync(paths.socket, { force: true });
    }
    return notRunning();
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
    if (!(await daemonState(paths)).running) {
      return { stopped: true, wasRunning: true, outcome: 'stopped', pid: state.pid, signal: null, detail: null, help: [] };
    }
  }
  // The ask did not take, so what is left is a signal - and every signal goes
  // through the same gate on the same evidence. The holder is read again here
  // rather than taken from `state.pid`, which was answered before the wait: a
  // daemon that exits while stopping and is replaced by its service manager
  // leaves that number naming a dead process the kernel may already have handed
  // to somebody else, which is the one thing `identifyDaemonProcess` exists to
  // prevent.
  const holder = inspectLock(paths.lockFile).liveHolder;
  if (holder === null) {
    return refusal(
      state.pid,
      `the daemon was asked to exit and is still answering, and nothing in ${paths.pidFile} names a live process to signal`,
      handOverHelp(state.pid),
    );
  }
  if (state.pid !== null && holder.pid !== state.pid) {
    // The daemon that was asked to exit is not the one holding the lock now,
    // which is what a service manager restarting a job looks like from here.
    // The same gate decides, on the same evidence as everywhere else: a
    // confirmed holder is a daemon serving this root, and telling the reader to
    // restart a job that has already been restarted would be advice for
    // something that has happened.
    const identity = identifyDaemonProcess(paths, holder, options.readProcess ?? readProcess);
    if (!identity.confirmed) {
      return refusal(
        holder.pid,
        `no signal was sent: the daemon that was asked to exit (pid ${state.pid}) is not the one holding ${paths.lockFile} now, and ${identity.reason}`,
        handOverHelp(holder.pid),
      );
    }
    const managed = managedJob(paths, options);
    return {
      stopped: false,
      wasRunning: true,
      outcome: 'replaced',
      pid: holder.pid,
      signal: null,
      detail:
        `no signal was sent: the daemon that was asked to exit (pid ${state.pid}) no longer holds ${paths.lockFile}, and pid ${holder.pid} - ` +
        `confirmed as this root's daemon - serves this root now${managed === null ? '' : `, under the managed job ${managed}`}`,
      help: managed === null
        ? ['Run `eyes-on daemon stop` again to end the daemon serving this root now']
        : managedHelp(managed),
    };
  }
  return signalHolder(paths, holder, timeoutMs, options);
}

function notRunning(): StopResult {
  return { stopped: false, wasRunning: false, outcome: 'not-running', pid: null, signal: null, detail: null, help: [] };
}

function refusal(pid: number | null, detail: string, help: string[]): StopResult {
  return { stopped: false, wasRunning: true, outcome: 'refused', pid, signal: null, detail, help };
}

/** The remedy for every holder eyes-on may not or cannot signal itself. */
function handOverHelp(pid: number | null): string[] {
  return [
    'Restart the eyes-on job through your service manager, or end the process holding the lock by hand',
    pid === null
      ? 'Run `eyes-on daemon status` to see what this run can read about the lock'
      : `Run \`ps -p ${pid} -o lstart=,args=\` to see what that pid is`,
  ];
}

type SignalOutcome = { kind: 'sent' } | { kind: 'gone' } | { kind: 'refused'; detail: string };

function sendSignal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): SignalOutcome {
  try {
    process.kill(pid, signal);
    return { kind: 'sent' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { kind: 'gone' };
    return { kind: 'refused', detail: code ?? (error as Error).message };
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!processAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

/**
 * Ends the live process holding the lock of a daemon that answers nothing.
 *
 * The order is the safety property: identify, signal, wait, confirm, and only
 * then remove anything. Every exit from here before the confirmation leaves the
 * root exactly as it found it.
 */
async function stopWedgedDaemon(
  paths: Paths,
  holder: LockHolder | null,
  timeoutMs: number,
  options: StopDaemonOptions,
): Promise<StopResult> {
  if (holder === null) {
    return refusal(
      null,
      `${paths.lockFile} is held by a process this run could not identify: nothing in ${paths.pidFile} names a live process, so there is no pid to signal`,
      handOverHelp(null),
    );
  }
  return signalHolder(paths, holder, timeoutMs, options);
}

/**
 * Signals the process the lock record names, and is the only place that sends a
 * signal to a daemon - the socket path arrives here too, once the ask has not
 * taken. `holder` is the record the lock produced a moment ago, never a pid a
 * caller carried across a wait.
 */
async function signalHolder(
  paths: Paths,
  holder: LockHolder,
  timeoutMs: number,
  options: StopDaemonOptions,
): Promise<StopResult> {
  const identity = identifyDaemonProcess(paths, holder, options.readProcess ?? readProcess);
  if (!identity.confirmed) {
    return refusal(
      holder.pid,
      `no signal was sent, because ${identity.reason}`,
      handOverHelp(holder.pid),
    );
  }

  const term = sendSignal(holder.pid, 'SIGTERM');
  if (term.kind === 'refused') {
    return refusal(
      holder.pid,
      `no signal was sent: this process may not signal pid ${holder.pid} (${term.detail}), which runs as another user`,
      handOverHelp(holder.pid),
    );
  }
  if (term.kind === 'gone') {
    return finishWedgedStop(paths, holder.pid, null, options);
  }
  if (await waitForExit(holder.pid, timeoutMs)) {
    return finishWedgedStop(paths, holder.pid, 'SIGTERM', options);
  }
  if (!options.force) {
    return {
      stopped: false,
      wasRunning: true,
      outcome: 'needs-force',
      pid: holder.pid,
      signal: 'SIGTERM',
      detail: `pid ${holder.pid} did not exit within ${Math.round(timeoutMs / 1000)}s of SIGTERM and still holds ${paths.lockFile}`,
      help: ['Run `eyes-on daemon stop --force` to end it with SIGKILL'],
    };
  }

  const kill = sendSignal(holder.pid, 'SIGKILL');
  if (kill.kind === 'refused') {
    return refusal(
      holder.pid,
      `pid ${holder.pid} survived SIGTERM and this process may not send it SIGKILL (${kill.detail})`,
      handOverHelp(holder.pid),
    );
  }
  if (kill.kind === 'gone' || (await waitForExit(holder.pid, Math.min(timeoutMs, 5000)))) {
    return finishWedgedStop(paths, holder.pid, 'SIGKILL', options);
  }
  return {
    stopped: false,
    wasRunning: true,
    outcome: 'still-running',
    pid: holder.pid,
    signal: 'SIGKILL',
    detail: `pid ${holder.pid} is still running after SIGKILL, so it is not a process this machine will let go`,
    help: handOverHelp(holder.pid),
  };
}

/**
 * The label of the job a service manager holds for this root, or null when
 * nothing manages it.
 *
 * This decides nothing, starts nothing and never carries a verdict on its own -
 * `startManagedJob` is still the only place that addresses a job, and what a
 * stop reports is decided by the lock and the identity gate. A loaded job says
 * only who would start the next daemon, so it is asked once a condition is
 * already established, to name the job in the sentence a person reads.
 */
function managedJob(paths: Paths, options: StopDaemonOptions): string | null {
  if (options.inspectService === undefined && serviceManagerBypassed()) return null;
  try {
    const status = (options.inspectService ?? inspectService)(paths);
    return status.supported && status.loaded ? status.label : null;
  } catch {
    // A manager that cannot be reached holds nothing this run can name.
    return null;
  }
}

/** The remedy for a replacement daemon somebody may not have wanted. */
function managedHelp(label: string): string[] {
  return [
    `Stop the job ${label} through your service manager if this root has to stay without a daemon`,
    'Run `eyes-on daemon status` to see the daemon serving this root now',
  ];
}

/**
 * What holds the lock once the process this call acted on is gone.
 *
 * A held lock has exactly two readings and they are told apart by the same gate
 * every signal passes, never by whether a service job happens to be loaded: a
 * holder the gate confirms is this root's daemon is a replacement daemon, and
 * anything else - a foreign process, a holder nothing names, a reading that
 * could not be taken - is somebody else's lock, which is state to leave alone
 * and report.
 */
type LockAfterSignal =
  | { kind: 'free' }
  | { kind: 'replacement'; pid: number }
  | { kind: 'foreign'; pid: number | null; reason: string };

function lockAfterSignal(paths: Paths, options: StopDaemonOptions): LockAfterSignal {
  const lock = inspectLock(paths.lockFile);
  if (lock.state !== 'held') return { kind: 'free' };
  const holder = lock.liveHolder;
  if (holder === null) {
    return { kind: 'foreign', pid: null, reason: `nothing in ${paths.pidFile} names the live process holding it` };
  }
  const identity = identifyDaemonProcess(paths, holder, options.readProcess ?? readProcess);
  return identity.confirmed
    ? { kind: 'replacement', pid: holder.pid }
    : { kind: 'foreign', pid: holder.pid, reason: identity.reason };
}

/**
 * What is left of a wedged daemon, once the process is confirmed gone.
 *
 * The lock is read again before anything is touched: the pid ending is not
 * proof the lock is free, and a lock somebody else now holds is state that
 * belongs to that process. `clearHolderRecord` needs the lock to do its write,
 * so even the record clearing cannot race a new holder, and the pid file is
 * removed only while it still names the process that just ended.
 *
 * Two readings are not a plain stop, and each one has to be evidenced rather
 * than assumed from a service job being loaded. A lock held by a process the
 * identity gate confirms is this root's daemon is a replacement daemon; a lock
 * held by anything else is somebody else's lock, whatever the manager holds.
 * And a free lock is a stop unless this call sent SIGKILL, which is the one
 * exit it can know was unsuccessful - the exit a managed job is restarted on.
 * A daemon that took SIGTERM and exited cleanly is not restarted by either
 * service manager, so that stop is reported as the stop it is.
 */
async function finishWedgedStop(
  paths: Paths,
  pid: number,
  signal: 'SIGTERM' | 'SIGKILL' | null,
  options: StopDaemonOptions,
): Promise<StopResult> {
  const after = lockAfterSignal(paths, options);
  if (after.kind === 'foreign') {
    return {
      stopped: false,
      wasRunning: true,
      outcome: 'lock-still-held',
      pid,
      signal,
      detail: `pid ${pid} has ended and ${paths.lockFile} is still held, so another process holds it and nothing was removed (${after.reason})`,
      help: ['Run `eyes-on daemon status` to see what holds the lock now'],
    };
  }
  if (after.kind === 'replacement') {
    const managed = managedJob(paths, options);
    return {
      stopped: false,
      wasRunning: true,
      outcome: 'replaced',
      pid,
      signal,
      detail:
        `pid ${pid} has ended, and pid ${after.pid} - confirmed as this root's daemon - holds ${paths.lockFile} now` +
        `${managed === null ? '' : `, under the managed job ${managed}`}, so nothing was removed`,
      help: managed === null
        ? ['Run `eyes-on daemon status` to see the daemon serving this root now']
        : managedHelp(managed),
    };
  }
  clearHolderRecord(paths.lockFile);
  if (readPidFile(paths) === pid) {
    rmSync(paths.pidFile, { force: true });
  }
  if (existsSync(paths.socket) && !(await probeSocket(paths.socket))) {
    rmSync(paths.socket, { force: true });
  }
  const managed = signal === 'SIGKILL' ? managedJob(paths, options) : null;
  if (managed !== null) {
    return {
      stopped: false,
      wasRunning: true,
      outcome: 'service-managed',
      pid,
      signal,
      detail: `pid ${pid} was ended with SIGKILL and ${paths.lockFile} is free - that is an unsuccessful exit, and the managed job ${managed} is restarted on one, so the service manager is expected to start a replacement daemon`,
      help: managedHelp(managed),
    };
  }
  return {
    stopped: true,
    wasRunning: true,
    outcome: 'stopped',
    pid,
    signal,
    detail: signal === null ? `pid ${pid} had already exited when the signal was sent` : null,
    help: [],
  };
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
