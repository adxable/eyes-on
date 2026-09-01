import { existsSync } from 'node:fs';
import type { Context } from './context.js';
import { emitDoc } from './output.js';
import type { ToonObject } from './toon.js';
import { daemonState, daemonStatus } from '../daemon/lifecycle.js';
import { currentBranch, headSHA, toplevel } from '../git/git.js';
import { canonicalPath } from '../core/repoid.js';

/**
 * `eyes-on status` - read-only, and required to keep working from inside a
 * no-mistakes run (report stage 0 acceptance: the recursion refusal must block
 * mutation without blinding the caller).
 */
export async function statusCommand(context: Context): Promise<number> {
  const state = await daemonState(context.paths);
  const status = state.running ? await daemonStatus(context.paths) : null;
  const top = toplevel(context.cwd);
  const clone = top ? canonicalPath(top) : null;
  const registered = clone !== null && (status?.repos ?? []).some((repo) => repo.workingPath === clone);

  const doc: ToonObject = {
    root: context.paths.root,
    state_root_present: existsSync(context.paths.root),
    daemon: state.running ? 'running' : 'stopped',
    daemon_pid: state.pid,
    daemon_uptime_seconds: state.uptimeSeconds,
    repo: clone ?? 'not a git repository',
    branch: clone ? (currentBranch(context.cwd) ?? 'detached') : '',
    head: clone ? (headSHA(context.cwd) ?? '')?.slice(0, 12) : '',
    registered,
    inside_no_mistakes_run: context.guard.insideGate,
    repos: (status?.repos ?? []).map((repo) => ({
      id: repo.id,
      path: repo.workingPath,
      default_branch: repo.defaultBranch,
      mirror_refs: repo.mirrorRefs,
      mirror_ok: repo.mirrorReachable,
    })),
    assessments: 0,
    help: [
      registered
        ? 'This repository is registered. Risk assessment (`eyes-on check`) arrives in stage 1.'
        : 'Run `eyes-on init` to register this repository with eyes-on',
      'Run `eyes-on doctor` for a full readiness and collision report',
    ],
  };

  emitDoc(context.writers, context.format, doc, renderMarkdown(doc));
  return 0;
}

function renderMarkdown(doc: ToonObject): string {
  const lines = [
    '# eyes-on status',
    '',
    `- state root: \`${String(doc.root)}\``,
    `- daemon: **${String(doc.daemon)}**${doc.daemon_pid ? ` (pid ${String(doc.daemon_pid)})` : ''}`,
    `- repository: \`${String(doc.repo)}\``,
    `- branch: ${String(doc.branch) || 'n/a'}`,
    `- registered with eyes-on: ${doc.registered ? 'yes' : 'no'}`,
    '',
    'No assessment has been recorded yet: risk scoring lands in stage 1.',
  ];
  return lines.join('\n');
}
