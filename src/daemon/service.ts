import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Paths } from '../core/paths.js';
import { SERVICE_LABEL_BASE } from '../core/version.js';

/**
 * The OS-managed service (report M14, U4, K15).
 *
 * The label is scoped by sha256 of the canonical state root, so eyes-on and
 * no-mistakes cannot collide by construction rather than by courtesy. The live
 * proof on the captain's machine is `com.kunchenguid.no-mistakes.daemon.733b4626`
 * (report Appendix A3): no-mistakes already scopes by root hash, eyes-on has a
 * different prefix *and* a different root, so the two labels can never be the
 * same string. A shared label would mean either tool's `stop` could tear down
 * the other's daemon - a failure no-mistakes hit twice before it scoped the
 * label (internal/daemon/service.go:280-305).
 *
 * A LaunchAgent exports only HOME and PATH (Appendix A3), so the service is
 * invoked with an explicit `--root`: nothing here may depend on EYES_HOME being
 * inherited.
 */

export type Platform = 'darwin' | 'linux' | 'other';

export function platform(): Platform {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'linux') return 'linux';
  return 'other';
}

/** First 4 bytes of sha256 over the canonical root, as 8 hex characters. */
export function instanceSuffix(paths: Paths): string {
  return createHash('sha256').update(paths.canonicalRoot()).digest('hex').slice(0, 8);
}

export function launchdLabel(paths: Paths): string {
  return `${SERVICE_LABEL_BASE}.${instanceSuffix(paths)}`;
}

export function systemdUnitName(paths: Paths): string {
  return `eyes-on-daemon-${instanceSuffix(paths)}.service`;
}

export function launchdPlistPath(paths: Paths): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${launchdLabel(paths)}.plist`);
}

export function systemdUnitPath(paths: Paths): string {
  return join(homedir(), '.config', 'systemd', 'user', systemdUnitName(paths));
}

/** Set to 1 to keep tests and sandboxes from registering a real service. */
export function serviceManagerBypassed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EYES_ON_SKIP_SERVICE_MANAGER === '1';
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function launchdPlist(paths: Paths, executable: string, nodePath: string): string {
  const label = launchdLabel(paths);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(executable)}</string>
    <string>daemon</string>
    <string>run</string>
    <string>--root</string>
    <string>${xmlEscape(paths.canonicalRoot())}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(paths.canonicalRoot())}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(homedir())}</string>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin')}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Restart on failure only. A daemon that exits 0 because another one
       already holds this root's lock must not be restarted in a loop. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(paths.logsDir, 'service.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(paths.logsDir, 'service.err.log'))}</string>
</dict>
</plist>
`;
}

/**
 * systemd splits `ExecStart` on whitespace, so every argument that can contain a
 * space is quoted. Without this a state root such as `/Users/a b/.eyes-on`
 * produces a unit that starts the daemon with the wrong argv, and one that can
 * never be read back as the definition it was written from - so every repeat
 * `init` would rewrite it and bounce a healthy daemon.
 */
function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function systemdUnit(paths: Paths, executable: string, nodePath: string): string {
  const argv = [nodePath, executable, 'daemon', 'run', '--root', paths.canonicalRoot()];
  return `[Unit]
Description=eyes-on daemon (${paths.canonicalRoot()})

[Service]
Type=simple
ExecStart=${argv.map(systemdQuote).join(' ')}
WorkingDirectory=${paths.canonicalRoot()}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

/** Splits a systemd command line, honouring double quotes and backslash escapes. */
function splitCommandLine(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (character === '\\' && index + 1 < value.length) {
      current += value[index + 1] as string;
      index += 1;
      started = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * Property lists are read by `/usr/bin/plutil`, the parser macOS itself uses.
 *
 * This is not a runtime dependency in the sense report section 7 forbids: it is
 * a system binary that ships with every macOS, on the only platform where a
 * LaunchAgent exists at all. A hand-written XML reader would have to learn
 * self-closing collections, self-closing leaves, binary plists and every other
 * shape the directory actually contains - one defect at a time - and the answer
 * it produces decides whether `doctor` reports a service collision, so it has to
 * be right about files nobody here wrote.
 */
export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

export type PlistRead =
  | { ok: true; value: { [key: string]: PlistValue } }
  | { ok: false; reason: string };

function runPlutil(args: string[], input?: string): { status: number; stdout: string; stderr: string } | string {
  const result = spawnSync('/usr/bin/plutil', args, { encoding: 'utf8', input, timeout: 10_000 });
  if (result.error) return String(result.error.message ?? result.error);
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** plutil prefixes its diagnostics with the file it was given; the caller knows. */
function plutilMessage(result: { stdout: string; stderr: string }, fallback: string): string {
  const raw = (result.stderr.trim() || result.stdout.trim()).split('\n')[0] ?? '';
  const colon = raw.indexOf(': ');
  const message = colon >= 0 ? raw.slice(colon + 2) : raw;
  return message.trim() || fallback;
}

/**
 * Reads a whole property list. Used for the unit eyes-on generates itself,
 * whose values are strings, arrays, dicts and booleans by construction - the
 * types `-convert json` can represent. A file that cannot be converted reads as
 * a failure, which makes `installService` rewrite and reload it rather than
 * trust it.
 */
export function readPlist(content: string): PlistRead {
  const result = runPlutil(['-convert', 'json', '-o', '-', '--', '-'], content);
  if (typeof result === 'string') return { ok: false, reason: result };
  if (result.status !== 0) {
    return { ok: false, reason: plutilMessage(result, `plutil exited ${result.status}`) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'the property list root is not a dictionary' };
  }
  return { ok: true, value: parsed as { [key: string]: PlistValue } };
}

export type LabelRead = { ok: true; label: string | null } | { ok: false; reason: string };

/**
 * The `Label` a foreign LaunchAgent declares, read without converting the rest
 * of the document.
 *
 * `-convert json` refuses any property list carrying a `<data>` or `<date>`
 * value, because JSON cannot represent them - and a value that has nothing to
 * do with the label must not decide whether the file is visible to the
 * collision check at all. `-extract` handles every value type.
 *
 * The two questions stay separate on purpose, because "I could not read this
 * file" and "this file names no job" are different facts and only the first is
 * worth a word from `doctor`: `-lint` answers whether the file is a property
 * list, `-extract` answers whether it declares a label. `-extract` alone cannot
 * tell them apart - it exits non-zero for both - so `-lint` runs to explain a
 * non-zero extract and only then. `doctor` reads every file in
 * ~/Library/LaunchAgents, and a declared label is the common case there, so the
 * question that usually answers itself is asked first.
 */
export function readPlistLabelFile(file: string): LabelRead {
  const extracted = runPlutil(['-extract', 'Label', 'raw', '-o', '-', '--', file]);
  if (typeof extracted !== 'string' && extracted.status === 0) {
    const label = extracted.stdout.trim();
    return { ok: true, label: label.length > 0 ? label : null };
  }
  const lint = runPlutil(['-lint', '--', file]);
  if (typeof lint === 'string') return { ok: false, reason: lint };
  if (lint.status !== 0) {
    return { ok: false, reason: plutilMessage(lint, `plutil -lint exited ${lint.status}`) };
  }
  // A property list that reads cleanly and declares no `Label` names no job, so
  // it can collide with nothing.
  return { ok: true, label: null };
}

/** The `Label` a property list declares, or null when it declares none. */
export function plistLabel(dict: { [key: string]: PlistValue }): string | null {
  const label = dict.Label;
  return typeof label === 'string' && label.length > 0 ? label : null;
}

/**
 * What a service definition *means*, with the environment-dependent parts left
 * out on purpose.
 *
 * `installService` compares this rather than the file's bytes. A LaunchAgent
 * carries the installing shell's PATH, so a byte comparison calls the unit
 * "changed" whenever init runs from nvm, direnv, an IDE terminal or an agent -
 * and reloading on that would bounce a healthy daemon on every init. Idempotent
 * has to mean "repairs what is broken", so only the fields below can trigger a
 * reload.
 */
export interface ServiceDefinition {
  label: string;
  argv: string[];
  workingDirectory: string;
  restart: 'always' | 'on-failure' | 'no';
  stdoutPath: string | null;
  stderrPath: string | null;
}

export function launchdDefinition(paths: Paths, executable: string, nodePath: string): ServiceDefinition {
  return {
    label: launchdLabel(paths),
    argv: [nodePath, executable, 'daemon', 'run', '--root', paths.canonicalRoot()],
    workingDirectory: paths.canonicalRoot(),
    restart: 'on-failure',
    stdoutPath: join(paths.logsDir, 'service.out.log'),
    stderrPath: join(paths.logsDir, 'service.err.log'),
  };
}

export function systemdDefinition(paths: Paths, executable: string, nodePath: string): ServiceDefinition {
  return {
    label: systemdUnitName(paths),
    argv: [nodePath, executable, 'daemon', 'run', '--root', paths.canonicalRoot()],
    workingDirectory: paths.canonicalRoot(),
    restart: 'on-failure',
    stdoutPath: null,
    stderrPath: null,
  };
}

export function parseLaunchdPlist(content: string): ServiceDefinition | null {
  const read = readPlist(content);
  if (!read.ok) return null;
  const dict = read.value;
  const label = dict.Label;
  const argv = dict.ProgramArguments;
  const workingDirectory = dict.WorkingDirectory;
  if (typeof label !== 'string' || !Array.isArray(argv) || typeof workingDirectory !== 'string') return null;
  if (!argv.every((entry): entry is string => typeof entry === 'string')) return null;
  const keepAlive = dict.KeepAlive;
  let restart: ServiceDefinition['restart'] = 'no';
  if (keepAlive === true) restart = 'always';
  else if (keepAlive !== undefined && typeof keepAlive === 'object' && !Array.isArray(keepAlive)) {
    restart = keepAlive.SuccessfulExit === false ? 'on-failure' : 'always';
  }
  return {
    label,
    argv,
    workingDirectory,
    restart,
    stdoutPath: typeof dict.StandardOutPath === 'string' ? dict.StandardOutPath : null,
    stderrPath: typeof dict.StandardErrorPath === 'string' ? dict.StandardErrorPath : null,
  };
}

/**
 * The unit name is not written inside the file, so the caller supplies the one
 * the file is stored under - which is what systemd itself addresses the job by.
 */
export function parseSystemdUnit(content: string, unitName: string): ServiceDefinition | null {
  const settings = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
    const equals = trimmed.indexOf('=');
    if (equals < 0) continue;
    settings.set(trimmed.slice(0, equals).trim(), trimmed.slice(equals + 1).trim());
  }
  const execStart = settings.get('ExecStart');
  const workingDirectory = settings.get('WorkingDirectory');
  if (execStart === undefined || workingDirectory === undefined) return null;
  const restartValue = settings.get('Restart');
  return {
    label: unitName,
    argv: splitCommandLine(execStart),
    workingDirectory,
    restart: restartValue === 'always' ? 'always' : restartValue === 'on-failure' ? 'on-failure' : 'no',
    stdoutPath: null,
    stderrPath: null,
  };
}

export function sameServiceDefinition(a: ServiceDefinition, b: ServiceDefinition): boolean {
  return (
    a.label === b.label &&
    a.workingDirectory === b.workingDirectory &&
    a.restart === b.restart &&
    a.stdoutPath === b.stdoutPath &&
    a.stderrPath === b.stderrPath &&
    a.argv.length === b.argv.length &&
    a.argv.every((token, index) => token === b.argv[index])
  );
}

export interface ServiceStatus {
  supported: boolean;
  label: string;
  unitPath: string;
  installed: boolean;
  /** True when the service manager holds the job definition. */
  loaded: boolean;
  /**
   * True when that job also has a live process. The distinction is the whole
   * point: the daemon exits 0 when it shuts down or finds another holding this
   * root's lock, and the job restarts on failure only, so a loaded job with no
   * process is a normal and permanent resting state - and it is exactly the
   * state `init` has to repair rather than route around.
   */
  running: boolean;
  pid: number | null;
}

export interface JobState {
  loaded: boolean;
  running: boolean;
  pid: number | null;
}

const NOT_LOADED: JobState = { loaded: false, running: false, pid: null };

/** `launchctl print` output, or null when the job is not loaded at all. */
export function parseLaunchctlPrint(output: string | null): JobState {
  if (output === null) return NOT_LOADED;
  const state = /^\s*state = (.+)$/m.exec(output)?.[1]?.trim() ?? '';
  const pid = /^\s*pid = (\d+)$/m.exec(output)?.[1];
  return {
    loaded: true,
    running: state === 'running' || pid !== undefined,
    pid: pid === undefined ? null : Number.parseInt(pid, 10),
  };
}

/** `systemctl --user show` output, or null when the unit could not be queried. */
export function parseSystemctlShow(output: string | null): JobState {
  if (output === null) return NOT_LOADED;
  const settings = new Map<string, string>();
  for (const line of output.split('\n')) {
    const equals = line.indexOf('=');
    if (equals > 0) settings.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
  }
  const loaded = settings.get('LoadState') === 'loaded';
  const mainPid = Number.parseInt(settings.get('MainPID') ?? '0', 10);
  const pid = Number.isFinite(mainPid) && mainPid > 0 ? mainPid : null;
  return { loaded, running: loaded && settings.get('ActiveState') === 'active' && pid !== null, pid };
}

function launchctlDomain(): string {
  return `gui/${userInfo().uid}`;
}

function jobState(paths: Paths, current: Platform): JobState {
  if (current === 'darwin') {
    const listed = spawnSync('launchctl', ['print', `${launchctlDomain()}/${launchdLabel(paths)}`], {
      encoding: 'utf8',
    });
    return parseLaunchctlPrint(listed.status === 0 ? (listed.stdout ?? '') : null);
  }
  if (current === 'linux') {
    const shown = spawnSync(
      'systemctl',
      ['--user', 'show', systemdUnitName(paths), '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID'],
      { encoding: 'utf8' },
    );
    return parseSystemctlShow(shown.status === 0 ? (shown.stdout ?? '') : null);
  }
  return NOT_LOADED;
}

export function inspectService(paths: Paths): ServiceStatus {
  const current = platform();
  if (current === 'other') {
    return { supported: false, label: '', unitPath: '', installed: false, loaded: false, running: false, pid: null };
  }
  const label = current === 'darwin' ? launchdLabel(paths) : systemdUnitName(paths);
  const unitPath = current === 'darwin' ? launchdPlistPath(paths) : systemdUnitPath(paths);
  const job = jobState(paths, current);
  return { supported: true, label, unitPath, installed: existsSync(unitPath), ...job };
}

/**
 * What the service manager did with this root's job when asked to start it.
 *
 *   - `unavailable`: no service manager holds a job here. It may be bypassed,
 *     an unsupported platform, have no unit file, or simply be unreachable - a
 *     host with no systemd user bus, or a launchd domain this session cannot
 *     address. Nothing is held, so nothing can be orphaned and the caller may
 *     spawn a daemon of its own.
 *   - `started`: the manager accepted the start, or already holds the job.
 *   - `refused`: the manager holds this job and would not start it. Spawning
 *     beside it is exactly the orphan split, so this is a failure to report,
 *     not a case to route around.
 */
export type ManagedJobOutcome = 'unavailable' | 'started' | 'refused';

export interface ManagedJobStart {
  outcome: ManagedJobOutcome;
  label: string;
  detail: string | null;
}

export interface CommandResult {
  status: number;
  stderr: string;
}

/**
 * The three things `startManagedJob` asks about the outside world, injectable so
 * a test can drive every branch without registering a real LaunchAgent or
 * systemd unit - including the one that only appears on a host whose service
 * manager cannot be reached.
 */
export interface ServiceManagerProbe {
  platform: () => Platform;
  inspect: (paths: Paths) => ServiceStatus;
  run: (command: string, argv: string[]) => CommandResult;
}

export const REAL_SERVICE_MANAGER: ServiceManagerProbe = {
  platform,
  inspect: inspectService,
  run: (command, argv) => {
    const result = spawnSync(command, argv, { encoding: 'utf8' });
    return { status: result.status ?? -1, stderr: (result.stderr ?? '').trim() };
  },
};

/**
 * Starts the managed job for this root, and is the only place that does.
 *
 * A daemon obtained any other way while a service manager holds a job for the
 * same root is the orphan split this product has now had to fix three times:
 * the unmanaged process wins the singleton lock, the managed one starts, finds
 * the lock taken, exits 0 - and `KeepAlive.SuccessfulExit=false` means it is
 * never restarted. `startDaemon` calls this before it considers spawning
 * anything, so `init`, `daemon start` and `daemon restart` all get the property
 * rather than only one of them.
 *
 * It asks the service manager what it holds and has no policy of its own: no
 * configuration is read here, because a job the manager still holds must never
 * be shadowed by a spawned daemon whatever the config says. Turning the managed
 * service off is `init`'s job, and it does it by removing the job rather than
 * by ignoring one that is still loaded.
 *
 * What decides between `unavailable` and `refused` is therefore whether the
 * manager actually holds the job, never whether a unit file happens to sit on
 * disk: `installService` writes that file before it ever tries to load it, so
 * on a host with no usable service manager the file exists and the job does not.
 */
export function startManagedJob(paths: Paths, probe: ServiceManagerProbe = REAL_SERVICE_MANAGER): ManagedJobStart {
  const unavailable = (detail: string, label = ''): ManagedJobStart => ({ outcome: 'unavailable', label, detail });

  if (serviceManagerBypassed()) return unavailable('EYES_ON_SKIP_SERVICE_MANAGER=1');
  const current = probe.platform();
  if (current === 'other') return unavailable(`unsupported platform ${process.platform}`);

  const status = probe.inspect(paths);

  if (status.loaded) {
    // `kickstart` without `-k` starts a loaded job and is a no-op on a running
    // one, so it never kills a process that is already coming up - and asking
    // the manager beats trusting a `running` flag that can still describe a
    // daemon which was told to exit a moment ago.
    const command =
      current === 'darwin'
        ? probe.run('launchctl', ['kickstart', `${launchctlDomain()}/${status.label}`])
        : probe.run('systemctl', ['--user', 'start', status.label]);
    if (command.status === 0) return { outcome: 'started', label: status.label, detail: null };
    return {
      outcome: 'refused',
      label: status.label,
      detail: command.stderr || `exited ${command.status}`,
    };
  }

  if (!status.installed) return unavailable('no managed service is installed for this root', status.label);

  // A unit file with no job behind it. Handing it to the manager is the last
  // thing that can tell the two cases apart: if it takes it, the job is ours to
  // wait for; if it cannot be reached, it holds nothing and a spawn is safe.
  const loaded =
    current === 'darwin'
      ? probe.run('launchctl', ['bootstrap', launchctlDomain(), status.unitPath])
      : probe.run('systemctl', ['--user', 'start', status.label]);
  if (loaded.status === 0) return { outcome: 'started', label: status.label, detail: null };

  // A load can fail *because* the manager already holds the job - two eyes-on
  // invocations racing for one root, where the loser sees `Bootstrap failed:
  // 37: Operation already in progress`. The job being loaded is what the caller
  // asked for, so only a manager that still holds nothing counts as unavailable.
  if (probe.inspect(paths).loaded) {
    return { outcome: 'started', label: status.label, detail: null };
  }
  return unavailable(
    `the service manager would not load ${status.label}: ${loaded.stderr || `exited ${loaded.status}`}`,
    status.label,
  );
}

export interface ServiceInstallResult {
  installed: boolean;
  label: string;
  unitPath: string;
  skipped: string | null;
  /**
   * True when this call replaced the definition and reloaded the job, which
   * means the daemon is coming up out of band right now. Callers must wait for
   * it rather than starting one of their own: a competing spawn would win the
   * singleton lock and leave the service-managed job exiting cleanly and never
   * restarting.
   */
  reloaded: boolean;
}

/**
 * Two independent questions about the unit already on disk, because they have
 * different answers and different costs:
 *
 *   - `sameBytes` decides whether to write. Writing is free, so any drift in
 *     the template - a new key, a repaired PATH - reaches an existing install.
 *   - `sameMeaning` decides whether to reload. Reloading restarts the daemon,
 *     so only a change to what the unit actually declares may trigger it.
 *
 * An unparsable file means neither, so a corrupted unit is repaired rather than
 * trusted.
 */
export interface InstalledUnit {
  sameBytes: boolean;
  sameMeaning: boolean;
}

export function inspectInstalledUnit(
  unitPath: string,
  content: string,
  desired: ServiceDefinition,
  parse: (installed: string) => ServiceDefinition | null,
): InstalledUnit {
  let onDisk: string;
  try {
    if (!existsSync(unitPath)) return { sameBytes: false, sameMeaning: false };
    onDisk = readFileSync(unitPath, 'utf8');
  } catch {
    return { sameBytes: false, sameMeaning: false };
  }
  let installed: ServiceDefinition | null;
  try {
    installed = parse(onDisk);
  } catch {
    installed = null;
  }
  return {
    sameBytes: onDisk === content,
    sameMeaning: installed !== null && sameServiceDefinition(installed, desired),
  };
}

export type InstallAction = 'leave-alone' | 'reinstall';

/**
 * What an already-installed service needs from `installService`, which owns the
 * *definition* and nothing else.
 *
 * A job the manager already holds keeps its definition whether or not it has a
 * process: tearing it down and re-bootstrapping it would be pointless churn
 * when only the process is missing, and `startManagedJob` is what supplies one.
 * Everything else - a changed declaration, or a definition the manager is not
 * holding at all - has to be written and loaded.
 */
export function installAction(sameMeaning: boolean, status: { loaded: boolean }): InstallAction {
  if (!sameMeaning) return 'reinstall';
  return status.loaded ? 'leave-alone' : 'reinstall';
}

/**
 * Writes and loads the service definition. Idempotent: the file is refreshed
 * whenever the template's bytes differ, but the job is reloaded only when the
 * unit's *meaning* changed - bytes alone, such as the installing shell's PATH,
 * never restart a healthy daemon.
 */
export function installService(paths: Paths, executable: string, nodePath: string): ServiceInstallResult {
  const current = platform();
  if (serviceManagerBypassed()) {
    return { installed: false, label: '', unitPath: '', skipped: 'EYES_ON_SKIP_SERVICE_MANAGER=1', reloaded: false };
  }
  if (current === 'other') {
    return { installed: false, label: '', unitPath: '', skipped: `unsupported platform ${process.platform}`, reloaded: false };
  }
  mkdirSync(paths.logsDir, { recursive: true });

  if (current === 'darwin') {
    const label = launchdLabel(paths);
    const unitPath = launchdPlistPath(paths);
    const content = launchdPlist(paths, executable, nodePath);
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    const existing = inspectInstalledUnit(unitPath, content, launchdDefinition(paths, executable, nodePath), (installed) =>
      parseLaunchdPlist(installed),
    );
    if (!existing.sameBytes) writeFileSync(unitPath, content, { mode: 0o644 });
    const action = installAction(existing.sameMeaning, inspectService(paths));
    // A held job whose declaration has not changed is left strictly alone,
    // running or not. Reloading it would bounce a healthy daemon on every
    // `init`, and idempotent has to mean "repairs what is broken", not
    // "restarts what is working"; a dead one needs a process, not a new
    // definition, and `startDaemon` supplies that through the same door every
    // other caller uses.
    if (action === 'leave-alone') {
      return { installed: true, label, unitPath, skipped: null, reloaded: false };
    }
    // bootout then bootstrap: launchd refuses to bootstrap an already-loaded
    // label, and this is the only sequence that is safe to repeat. It targets
    // our own scoped label, never a shared one.
    spawnSync('launchctl', ['bootout', `${launchctlDomain()}/${label}`], { encoding: 'utf8' });
    const loaded = spawnSync('launchctl', ['bootstrap', launchctlDomain(), unitPath], { encoding: 'utf8' });
    if (loaded.status !== 0) {
      return {
        installed: true,
        label,
        unitPath,
        skipped: `launchctl bootstrap: ${(loaded.stderr ?? '').trim()}`,
        reloaded: false,
      };
    }
    return { installed: true, label, unitPath, skipped: null, reloaded: true };
  }

  const label = systemdUnitName(paths);
  const unitPath = systemdUnitPath(paths);
  const content = systemdUnit(paths, executable, nodePath);
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  const existing = inspectInstalledUnit(unitPath, content, systemdDefinition(paths, executable, nodePath), (installed) =>
    parseSystemdUnit(installed, label),
  );
  if (!existing.sameBytes) writeFileSync(unitPath, content, { mode: 0o644 });
  const action = installAction(existing.sameMeaning, inspectService(paths));
  if (action === 'leave-alone') {
    return { installed: true, label, unitPath, skipped: null, reloaded: false };
  }
  spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  const enabled = spawnSync('systemctl', ['--user', 'enable', '--now', label], { encoding: 'utf8' });
  if (enabled.status !== 0) {
    return {
      installed: true,
      label,
      unitPath,
      skipped: `systemctl enable: ${(enabled.stderr ?? '').trim()}`,
      reloaded: false,
    };
  }
  return { installed: true, label, unitPath, skipped: null, reloaded: true };
}

/** Unloads and removes the service definition for this root only. */
export function uninstallService(paths: Paths): boolean {
  const current = platform();
  if (current === 'darwin') {
    const unitPath = launchdPlistPath(paths);
    spawnSync('launchctl', ['bootout', `${launchctlDomain()}/${launchdLabel(paths)}`], { encoding: 'utf8' });
    if (!existsSync(unitPath)) return false;
    rmSync(unitPath, { force: true });
    return true;
  }
  if (current === 'linux') {
    const unitPath = systemdUnitPath(paths);
    spawnSync('systemctl', ['--user', 'disable', '--now', systemdUnitName(paths)], { encoding: 'utf8' });
    if (!existsSync(unitPath)) return false;
    rmSync(unitPath, { force: true });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
    return true;
  }
  return false;
}
