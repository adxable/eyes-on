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

function plutil(args: string[], input?: string): PlistRead {
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', ...args], {
    encoding: 'utf8',
    input,
    timeout: 10_000,
  });
  if (result.error) return { ok: false, reason: String(result.error.message ?? result.error) };
  if (result.status !== 0) {
    return { ok: false, reason: (result.stderr ?? '').trim() || `plutil exited ${result.status}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout ?? '');
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'the property list root is not a dictionary' };
  }
  return { ok: true, value: parsed as { [key: string]: PlistValue } };
}

/** Reads a property list held in memory. */
export function readPlist(content: string): PlistRead {
  return plutil(['--', '-'], content);
}

/** Reads a property list from disk, so binary plists work as well as XML ones. */
export function readPlistFile(file: string): PlistRead {
  return plutil(['--', file]);
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
  /** True when the service manager reports the job as loaded. */
  loaded: boolean;
}

function launchctlDomain(): string {
  return `gui/${userInfo().uid}`;
}

export function inspectService(paths: Paths): ServiceStatus {
  const current = platform();
  if (current === 'darwin') {
    const label = launchdLabel(paths);
    const unitPath = launchdPlistPath(paths);
    const installed = existsSync(unitPath);
    const listed = spawnSync('launchctl', ['print', `${launchctlDomain()}/${label}`], { encoding: 'utf8' });
    return { supported: true, label, unitPath, installed, loaded: listed.status === 0 };
  }
  if (current === 'linux') {
    const label = systemdUnitName(paths);
    const unitPath = systemdUnitPath(paths);
    const installed = existsSync(unitPath);
    const listed = spawnSync('systemctl', ['--user', 'is-active', label], { encoding: 'utf8' });
    return { supported: true, label, unitPath, installed, loaded: (listed.stdout ?? '').trim() === 'active' };
  }
  return { supported: false, label: '', unitPath: '', installed: false, loaded: false };
}

export interface ServiceInstallResult {
  installed: boolean;
  label: string;
  unitPath: string;
  skipped: string | null;
  /**
   * True when this call actually (re)started the managed job, which means the
   * daemon is coming up out of band right now. Callers must wait for it rather
   * than starting one of their own: a competing spawn would win the singleton
   * lock and leave the service-managed job exiting cleanly and never restarting.
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
    // A job whose declaration has not changed and is already loaded is left
    // strictly alone. Reloading it would bounce a healthy daemon on every
    // `init`, and idempotent has to mean "repairs what is broken", not
    // "restarts what is working".
    if (existing.sameMeaning && inspectService(paths).loaded) {
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
  if (existing.sameMeaning && inspectService(paths).loaded) {
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
