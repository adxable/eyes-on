import { existsSync } from 'node:fs';
import type { Context } from './context.js';
import { emitDoc } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { daemonState, daemonStatus } from '../daemon/lifecycle.js';
import { currentBranch, headSHA, toplevel } from '../git/git.js';
import { canonicalPath, repoID } from '../core/repoid.js';
import { Database, findRepoByPath } from '../db/db.js';
import { latestCheck, type CheckRow } from '../db/checks.js';
import { bandLabel, type Band } from '../risk/signals.js';

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
  // Asked of the daemon when there is one, and of the database when there is
  // not. Reading "registered: no" off a stopped daemon would describe the
  // daemon, not the repository - and the repository is what was asked about.
  const registered =
    clone !== null &&
    ((status?.repos ?? []).some((repo) => repo.workingPath === clone) || isRegistered(context, clone));

  const assessment = clone ? lastAssessment(context, clone, currentBranch(context.cwd)) : null;

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
    last_check: assessment
      ? ({
          branch: assessment.branch,
          head: assessment.head_sha.slice(0, 12),
          score: assessment.score,
          // The denominator the score was computed under, recorded beside it.
          // Null on a row written before eyes-on stored it, which is not the
          // same as 100 and must not be reported as it.
          score_max: assessment.score_max,
          band: assessment.band,
          status: assessment.status,
          when: new Date(assessment.updated_at * 1000).toISOString(),
        } as ToonValue)
      : null,
    help: [
      assessment
        ? 'Re-run `eyes-on check` to assess the current head, or `eyes-on why <file>` for one file'
        : registered
          ? 'This repository is registered. Run `eyes-on check` to assess the current change'
          : 'Run `eyes-on init` to register this repository with eyes-on',
      'Run `eyes-on doctor` for a full readiness and collision report',
    ],
  };

  emitDoc(context.writers, context.format, doc, renderMarkdown(doc, assessment));
  return 0;
}

/** Whether the repository has a row in the state database. */
function isRegistered(context: Context, clone: string): boolean {
  if (!existsSync(context.paths.db)) return false;
  try {
    const db = Database.open(context.paths.db);
    try {
      return findRepoByPath(db, clone) !== undefined;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * The most recent recorded assessment of this branch.
 *
 * Read-only and best effort: `status` must keep working on a machine where
 * `init` has never run, and from inside a no-mistakes run where mutation is
 * refused. A missing database is "no assessment yet", not a failure.
 */
function lastAssessment(context: Context, clone: string, branch: string | null): CheckRow | null {
  if (!existsSync(context.paths.db) || branch === null) return null;
  try {
    const db = Database.open(context.paths.db);
    try {
      return latestCheck(db, repoID(clone), branch) ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function renderMarkdown(doc: ToonObject, assessment: CheckRow | null): string {
  const lines = [
    '# eyes-on status',
    '',
    `- state root: \`${String(doc.root)}\``,
    `- daemon: **${String(doc.daemon)}**${doc.daemon_pid ? ` (pid ${String(doc.daemon_pid)})` : ''}`,
    `- repository: \`${String(doc.repo)}\``,
    `- branch: ${String(doc.branch) || 'n/a'}`,
    `- registered with eyes-on: ${doc.registered ? 'yes' : 'no'}`,
    '',
  ];
  if (assessment) {
    const head = assessment.head_sha.slice(0, 12);
    const current = String(doc.head) === head ? '' : ' (the head has moved since)';
    const outOf = assessment.score_max === null ? '' : `/${assessment.score_max}`;
    lines.push(
      `**${assessment.score ?? 0}${outOf} - ${bandLabel((assessment.band ?? 'auto') as Band)}** at \`${head}\`${current}.`,
      '',
    );
    if (assessment.score_max === null) {
      lines.push(
        'This assessment was recorded before eyes-on stored the maximum a score can reach, so the number above has no denominator here. Re-run `eyes-on check` to record one.',
        '',
      );
    }
    lines.push(
      assessment.status === 'unverified'
        ? 'Recorded as `unverified`: the trusted configuration could not be read, so the hard rules were not evaluated.'
        : 'Run `eyes-on check` to assess the current head.',
    );
  } else {
    lines.push('No assessment has been recorded for this branch yet. Run `eyes-on check`.');
  }
  return lines.join('\n');
}
