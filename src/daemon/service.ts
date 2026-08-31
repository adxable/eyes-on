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

export function systemdUnit(paths: Paths, executable: string, nodePath: string): string {
  return `[Unit]
Description=eyes-on daemon (${paths.canonicalRoot()})

[Service]
Type=simple
ExecStart=${nodePath} ${executable} daemon run --root ${paths.canonicalRoot()}
WorkingDirectory=${paths.canonicalRoot()}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
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
 * Writes and loads the service definition. Idempotent: an unchanged unit file
 * is left alone, a changed one is rewritten and reloaded.
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
    const unchanged = existsSync(unitPath) && readFileSync(unitPath, 'utf8') === content;
    if (!unchanged) writeFileSync(unitPath, content, { mode: 0o644 });
    // An unchanged, already-loaded job is left strictly alone. Reloading it
    // would bounce a healthy daemon on every `init`, and idempotent has to mean
    // "repairs what is broken", not "restarts what is working".
    if (unchanged && inspectService(paths).loaded) {
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
  const unchanged = existsSync(unitPath) && readFileSync(unitPath, 'utf8') === content;
  if (!unchanged) writeFileSync(unitPath, content, { mode: 0o644 });
  if (unchanged && inspectService(paths).loaded) {
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
