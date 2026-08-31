import { existsSync } from 'node:fs';
import { assertMayMutate, requireRepo, type Context } from './context.js';
import { flagBool } from './args.js';
import { emitDoc, progress, UserFacingError } from './output.js';
import type { ToonObject } from './toon.js';
import { Daemon } from '../daemon/daemon.js';
import { ensureConfig } from '../core/config.js';
import { daemonState, startDaemon, waitForDaemon, cliEntryPath } from '../daemon/lifecycle.js';
import { call } from '../ipc/client.js';
import { METHODS, type RegisterRepoResult } from '../ipc/protocol.js';
import { installSkill, skillRoot } from '../skill/install.js';
import { installPostCommitHook, inspectPostCommitHook, type HookResult } from '../git/hook.js';
import { installService, inspectService, serviceManagerBypassed } from '../daemon/service.js';
import { mirrorSizeBytes } from '../git/mirror.js';
import { loadConfig } from '../core/config.js';

/**
 * `eyes-on init` (report M1, section 2.2).
 *
 * Adopted wholesale from no-mistakes' init (internal/cli/init.go:29-90): create
 * the state root, provision the per-repository artefact, register the row,
 * start the daemon, install the skill. What is *not* adopted is the artefact
 * itself - no-mistakes provisions a gate that accepts pushes, eyes-on
 * provisions a mirror it only fetches into (report D2, M2).
 *
 * The property that matters most is idempotency. A second `init` must repair,
 * not duplicate: the repository row is keyed on the clone path, the mirror is
 * rebuilt only when broken, the skill is rewritten only when stale, the daemon
 * is started only when not already answering, and the hook is refreshed rather
 * than stacked. `--force` rebuilds the mirror and rewrites the config from
 * scratch; it never deletes recorded history.
 */
export async function initCommand(context: Context): Promise<number> {
  assertMayMutate(context, 'init');
  const clone = requireRepo(context);
  const force = flagBool(context.args, 'force');
  const watch = flagBool(context.args, 'watch');

  progress(context.writers, `eyes-on: registering ${clone}`);

  Daemon.ensureStateRoot(context.paths);
  const configWritten = ensureConfig(context.paths, force);

  const before = await daemonState(context.paths);

  // The OS service is registered before the daemon is started, so that the
  // service manager owns the process rather than racing a manually spawned one
  // for the singleton lock. Spawning directly is the fallback for platforms
  // and sandboxes without a usable service manager.
  const config = loadConfig(context.paths);
  const service =
    config.daemon.managed_service && !serviceManagerBypassed()
      ? installService(context.paths, cliEntryPath(), process.execPath)
      : { installed: false, label: '', unitPath: '', skipped: 'disabled in config or bypassed by environment' };
  if (service.installed && service.skipped === null && !before.running) {
    await waitForDaemon(context.paths, 10_000);
  }

  const start = await startDaemon(context.paths);
  if (!start.alreadyRunning && !start.started) {
    throw new UserFacingError('the eyes-on daemon did not start', [
      `Run \`eyes-on daemon run --root ${context.paths.root}\` in the foreground to see why`,
      `Check ${context.paths.daemonLog}`,
    ]);
  }
  progress(context.writers, before.running ? 'eyes-on: daemon already running' : 'eyes-on: daemon started');

  const registration = await call<RegisterRepoResult>(
    context.paths.socket,
    METHODS.registerRepo,
    { workingPath: clone, force },
    60_000,
  );
  progress(
    context.writers,
    `eyes-on: mirror ${registration.mirrorCreated ? 'created' : registration.mirrorRepaired ? 'repaired' : 'refreshed'} in ${registration.mirrorFetchMs} ms`,
  );

  const skills = installSkill(skillRoot(context.env));

  let hook: HookResult | null = null;
  if (watch) {
    hook = installPostCommitHook(clone, process.argv[1] ?? 'eyes-on');
    progress(context.writers, `eyes-on: post-commit hook ${hook.action}`);
  }

  const doc: ToonObject = {
    repo: registration.workingPath,
    repo_id: registration.repoID,
    default_branch: registration.defaultBranch,
    state_root: context.paths.root,
    config_written: configWritten,
    mirror: registration.mirrorPath,
    mirror_created: registration.mirrorCreated,
    mirror_repaired: registration.mirrorRepaired,
    mirror_refs: registration.mirrorRefs,
    mirror_fetch_ms: registration.mirrorFetchMs,
    mirror_bytes: mirrorSizeBytes(registration.mirrorPath),
    daemon: start.alreadyRunning ? 'already running' : 'started',
    daemon_pid: start.pid,
    service_label: service.label || 'not installed',
    service_note: service.skipped ?? '',
    skills: skills.map((entry) => ({ path: entry.path, written: entry.written })),
    hook: hook ? hook.action : 'not requested',
    hook_path: hook?.path ?? '',
    preserved_foreign_hook: hook?.preservedPath ?? '',
    help: [
      'Assess a change before pushing it: `eyes-on check` (arrives in stage 1)',
      'Check readiness and collisions: `eyes-on doctor`',
      watch
        ? 'The post-commit hook notifies the daemon in the background and never fails a commit'
        : 'Run `eyes-on init --watch` to also install a post-commit hook in this clone',
    ],
  };

  emitDoc(context.writers, context.format, doc, renderMarkdown(doc, context));
  return 0;
}

function renderMarkdown(doc: ToonObject, context: Context): string {
  const service = inspectService(context.paths);
  const hookStatus = inspectPostCommitHook(context.cwd);
  const lines = [
    'eyes-on is set up for this repository.',
    '',
    `  repository   ${String(doc.repo)}`,
    `  repo id      ${String(doc.repo_id)}`,
    `  state root   ${String(doc.state_root)}`,
    `  mirror       ${String(doc.mirror)} (${String(doc.mirror_refs)} refs, ${formatBytes(Number(doc.mirror_bytes))})`,
    `  daemon       ${String(doc.daemon)}${doc.daemon_pid ? ` (pid ${String(doc.daemon_pid)})` : ''}`,
    `  service      ${service.supported && service.installed ? service.label : String(doc.service_note || 'not installed')}`,
    `  skill        /eyes-on installed for this user`,
    `  post-commit  ${hookStatus.managed ? 'installed' : String(doc.hook)}`,
    '',
    'Assess a change before it is merged: `eyes-on check` (stage 1).',
    'See what is available and what is degraded: `eyes-on doctor`.',
  ];
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Whether the state root looks initialized. Used by doctor. */
export function stateRootInitialized(root: string): boolean {
  return existsSync(root);
}
