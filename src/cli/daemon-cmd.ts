import { assertMayMutate, pathsAt, type Context } from './context.js';
import { flagString } from './args.js';
import { emitDoc, EXIT_USAGE, progress, UserFacingError } from './output.js';
import type { ToonObject } from './toon.js';
import { runDaemon } from '../daemon/daemon.js';
import { LockHeldError } from '../daemon/lock.js';
import { daemonState, daemonStatus, describeDaemon, restartDaemon, startDaemon, stopDaemon } from '../daemon/lifecycle.js';
import { call } from '../ipc/client.js';
import { METHODS, type NotifyCommitResult } from '../ipc/protocol.js';
import { toplevel } from '../git/git.js';
import { canonicalPath } from '../core/repoid.js';

/**
 * `eyes-on daemon {start|stop|restart|status|run|notify-commit}`.
 *
 * `run` is the foreground entry point the OS service invokes with an explicit
 * `--root`, because a LaunchAgent exports only HOME and PATH (report Appendix
 * A3) and nothing here may rely on inheriting EYES_HOME.
 *
 * `notify-commit` is what the post-commit hook calls. It is deliberately
 * forgiving: an unreachable daemon is reported and exits 0, because a hook that
 * fails a commit would be a worse product than one that occasionally misses a
 * background refresh (report D.2).
 */
export async function daemonCommand(context: Context): Promise<number> {
  const subcommand = context.args.positional[1] ?? 'status';

  switch (subcommand) {
    case 'run':
      return daemonRun(context);
    case 'start':
      return daemonStart(context);
    case 'stop':
      return daemonStop(context);
    case 'restart':
      return daemonRestart(context);
    case 'status':
      return daemonStatusCommand(context);
    case 'notify-commit':
      return daemonNotifyCommit(context);
    default:
      throw new UserFacingError(
        `unknown daemon subcommand ${subcommand}`,
        ['Use one of: start, stop, restart, status, run --root <dir>, notify-commit'],
        EXIT_USAGE,
      );
  }
}

async function daemonRun(context: Context): Promise<number> {
  const root = flagString(context.args, 'root');
  const paths = root ? pathsAt(root) : context.paths;
  progress(context.writers, `eyes-on: daemon starting on ${paths.root}`);
  try {
    await runDaemon(paths);
  } catch (error) {
    if (error instanceof LockHeldError) {
      // Another daemon already serves this root, so there is nothing to do and
      // nothing has gone wrong. Exiting 0 matters: the OS service is configured
      // to restart only on failure, so a non-zero exit here would put a
      // service-managed daemon into a restart loop against a healthy one.
      progress(context.writers, `eyes-on: ${error.message}; nothing to do`);
      return 0;
    }
    throw error;
  }
  return 0;
}

async function daemonStart(context: Context): Promise<number> {
  assertMayMutate(context, 'daemon start');
  const result = await startDaemon(context.paths);
  if (!result.started && !result.alreadyRunning) {
    throw new UserFacingError(result.detail ?? 'the eyes-on daemon did not start', [
      `Run \`eyes-on daemon run --root ${context.paths.root}\` in the foreground to see why`,
      `Check ${context.paths.daemonLog}`,
    ]);
  }
  const doc: ToonObject = {
    daemon: result.alreadyRunning ? 'already running' : 'started',
    pid: result.pid,
    via: result.via,
    root: context.paths.root,
  };
  emitDoc(context.writers, context.format, doc, `eyes-on daemon ${String(doc.daemon)} (pid ${String(doc.pid)})`);
  return 0;
}

async function daemonStop(context: Context): Promise<number> {
  assertMayMutate(context, 'daemon stop');
  const result = await stopDaemon(context.paths);
  const doc: ToonObject = {
    daemon: result.wasRunning ? (result.stopped ? 'stopped' : 'still running') : 'was not running',
    root: context.paths.root,
  };
  emitDoc(context.writers, context.format, doc, `eyes-on daemon ${String(doc.daemon)}`);
  return result.wasRunning && !result.stopped ? 1 : 0;
}

async function daemonRestart(context: Context): Promise<number> {
  assertMayMutate(context, 'daemon restart');
  const result = await restartDaemon(context.paths);
  const doc: ToonObject = {
    daemon: result.started ? 'restarted' : 'not running',
    pid: result.pid,
    via: result.via,
    detail: result.detail ?? '',
  };
  emitDoc(context.writers, context.format, doc, `eyes-on daemon ${String(doc.daemon)}`);
  return result.started ? 0 : 1;
}

async function daemonStatusCommand(context: Context): Promise<number> {
  const state = await daemonState(context.paths);
  const status = state.running ? await daemonStatus(context.paths) : null;
  const doc: ToonObject = {
    daemon: state.running ? 'running' : 'stopped',
    pid: state.pid,
    root: context.paths.root,
    version: state.version ?? '',
    uptime_seconds: state.uptimeSeconds,
    socket: context.paths.socket,
    lock: context.paths.lockFile,
    // What the lock actually says, in the same words `doctor` uses. A pid
    // appears under `lock_holder_pid` only when a live process holds the lock
    // while the socket stays silent; a record left by a process that has since
    // died is reported as the stale lock it is, and never as a holder.
    lock_state: state.diagnosis.kind,
    lock_holder_pid: state.diagnosis.kind === 'wedged' ? state.diagnosis.pid : null,
    stale_lock_pid: state.diagnosis.kind === 'stale-lock' ? state.diagnosis.pid : null,
    detail: describeDaemon(state, context.paths.lockFile),
    repos: (status?.repos ?? []).map((repo) => ({
      id: repo.id,
      path: repo.workingPath,
      mirror_refs: repo.mirrorRefs,
      mirror_ok: repo.mirrorReachable,
    })),
    help: state.running
      ? ['Stop it with `eyes-on daemon stop`']
      : state.diagnosis.kind === 'wedged'
        ? [
            'A live process holds the lock while nothing answers the socket: end that process, or restart the eyes-on job through your service manager',
            '`eyes-on daemon stop` acts on a daemon that answers, so it does not end this one',
          ]
        : ['Start it with `eyes-on daemon start`'],
  };
  emitDoc(
    context.writers,
    context.format,
    doc,
    `eyes-on daemon ${describeDaemon(state, context.paths.lockFile)}`,
  );
  return 0;
}

/**
 * Called by the post-commit hook. Never fails the caller: an unreachable daemon
 * is a fact to report, not a reason to make somebody's commit look broken.
 */
async function daemonNotifyCommit(context: Context): Promise<number> {
  const top = toplevel(context.cwd);
  if (!top) {
    emitDoc(context.writers, context.format, { accepted: false, reason: 'not inside a git repository' });
    return 0;
  }
  try {
    const result = await call<NotifyCommitResult>(
      context.paths.socket,
      METHODS.notifyCommit,
      { workingPath: canonicalPath(top) },
      5000,
    );
    emitDoc(context.writers, context.format, {
      accepted: result.accepted,
      repo_id: result.repoID ?? '',
      reason: result.reason ?? '',
    });
  } catch (error) {
    emitDoc(context.writers, context.format, { accepted: false, reason: (error as Error).message });
  }
  return 0;
}
