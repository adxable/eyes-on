import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from './context.js';
import { emitDoc } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { gitVersion, toplevel } from '../git/git.js';
import { canonicalPath, repoID } from '../core/repoid.js';
import { inspectMirror, mirrorSizeBytes } from '../git/mirror.js';
import { daemonState, daemonStatus } from '../daemon/lifecycle.js';
import { inspectService } from '../daemon/service.js';
import { inspectSkill, skillRoot } from '../skill/install.js';
import { inspectPostCommitHook } from '../git/hook.js';
import { Database } from '../db/db.js';

/**
 * `eyes-on doctor` (report section 2.2, R3, R8, R9, R11).
 *
 * Three jobs, and the last two are the ones that matter on the captain's
 * machine:
 *
 *   1. readiness - git, node, gh, the state root, the database;
 *   2. degradation - what eyes-on cannot do here and what that costs. The
 *      product must work without no-mistakes, without gh and without a model,
 *      so it has to be able to say which of those it is missing;
 *   3. coexistence - two auto-starting daemons on one machine is a design
 *      consequence (R3), so doctor names both services and says which is whose.
 *
 * Everything here is read-only. doctor never writes into any state root - not
 * its own, and emphatically not somebody else's.
 */

type Level = 'ok' | 'warn' | 'missing';

interface Row {
  check: string;
  status: Level;
  detail: string;
}

function which(binary: string): string | null {
  const result = spawnSync('command', ['-v', binary], { encoding: 'utf8', shell: '/bin/sh' });
  const path = (result.stdout ?? '').trim();
  return result.status === 0 && path.length > 0 ? path : null;
}

function ghAuthenticated(): boolean {
  const gh = which('gh');
  if (!gh) return false;
  return spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', timeout: 10_000 }).status === 0;
}

export async function doctorCommand(context: Context): Promise<number> {
  const rows: Row[] = [];
  const degradations: string[] = [];

  // 1. Toolchain.
  const git = gitVersion();
  rows.push({ check: 'git', status: git ? 'ok' : 'missing', detail: git ?? 'not found' });
  if (!git) degradations.push('git is missing: eyes-on cannot read history, so nothing works');

  rows.push({ check: 'node', status: 'ok', detail: process.version });
  const nodeMajor = Number.parseInt(process.version.replace(/^v/, ''), 10);
  if (Number.isFinite(nodeMajor) && nodeMajor < 22) {
    rows.push({ check: 'node version', status: 'missing', detail: 'eyes-on requires Node >= 22.5' });
  }

  const gh = which('gh');
  const ghAuth = gh ? ghAuthenticated() : false;
  rows.push({
    check: 'gh',
    status: gh ? (ghAuth ? 'ok' : 'warn') : 'missing',
    detail: gh ? (ghAuth ? `${gh} (authenticated)` : `${gh} (not authenticated)`) : 'not found',
  });
  if (!gh) degradations.push('gh is missing: pull-request observation and the sticky comment (stages 2-3) are unavailable');
  else if (!ghAuth) degradations.push('gh is not authenticated: run `gh auth login` before stages 2-3');

  // 2. State root and database.
  const rootExists = existsSync(context.paths.root);
  rows.push({
    check: 'state root',
    status: rootExists ? 'ok' : 'missing',
    detail: rootExists ? context.paths.root : `${context.paths.root} (run \`eyes-on init\`)`,
  });

  let dbTables = 0;
  if (existsSync(context.paths.db)) {
    try {
      const db = Database.openReadOnly(context.paths.db);
      dbTables = db.tables().length;
      db.close();
      rows.push({ check: 'database', status: 'ok', detail: `${context.paths.db} (${dbTables} tables)` });
    } catch (error) {
      rows.push({ check: 'database', status: 'missing', detail: (error as Error).message });
    }
  } else {
    rows.push({ check: 'database', status: 'missing', detail: 'not created yet (run `eyes-on init`)' });
  }

  // 3. Daemon and service.
  const state = await daemonState(context.paths);
  rows.push({
    check: 'daemon',
    status: state.running ? 'ok' : 'warn',
    detail: state.running
      ? `running (pid ${state.pid}, up ${state.uptimeSeconds}s)`
      : state.lockHolder
        ? `not answering, but the singleton lock is held by pid ${state.lockHolder.pid}`
        : 'stopped (run `eyes-on daemon start`)',
  });

  const service = inspectService(context.paths);
  rows.push({
    check: 'service',
    status: service.supported ? (service.installed ? 'ok' : 'warn') : 'warn',
    detail: service.supported
      ? `${service.label} (${service.installed ? 'installed' : 'not installed'}${service.loaded ? ', loaded' : ''})`
      : `no service manager integration for ${process.platform}`,
  });

  // 4. This repository, its mirror and its hook.
  const top = toplevel(context.cwd);
  const clone = top ? canonicalPath(top) : null;
  const status = state.running ? await daemonStatus(context.paths) : null;
  const known = clone ? (status?.repos ?? []).find((repo) => repo.workingPath === clone) : undefined;
  const id = known?.id ?? (clone ? repoID(clone) : null);

  rows.push({
    check: 'repository',
    status: clone ? (known ? 'ok' : 'warn') : 'missing',
    detail: clone
      ? known
        ? `${clone} (registered, id ${id})`
        : `${clone} (not registered - run \`eyes-on init\`)`
      : 'not inside a git repository',
  });

  let mirrorBytes = 0;
  if (id) {
    const mirrorPath = context.paths.mirrorDir(id);
    const mirror = inspectMirror(mirrorPath);
    mirrorBytes = mirror.exists ? mirrorSizeBytes(mirrorPath) : 0;
    rows.push({
      check: 'mirror',
      status: mirror.exists ? (mirror.alternateReachable ? 'ok' : 'missing') : 'warn',
      detail: mirror.exists
        ? mirror.alternateReachable
          ? `${mirrorPath} (${mirror.refs} refs, ${mirrorBytes} bytes, alternates -> ${mirror.alternate})`
          : `${mirrorPath} has an unreachable alternate (${mirror.alternate}); run \`eyes-on init --force\` to rebuild`
        : 'not built yet',
    });
    if (mirror.exists && !mirror.alternateReachable) {
      degradations.push(
        'the mirror borrows objects from the clone, and that clone is gone: the mirror is a rebuildable cache, so rebuild it with `eyes-on init --force`',
      );
    }
  }

  if (clone) {
    const hook = inspectPostCommitHook(clone);
    rows.push({
      check: 'post-commit hook',
      status: hook.managed ? 'ok' : 'warn',
      detail: hook.managed
        ? `${hook.path}${hook.preservedForeign ? ' (a pre-existing hook is preserved and still runs)' : ''}`
        : hook.present
          ? `${hook.path} exists but is not the eyes-on hook - eyes-on will preserve it if you run \`init --watch\``
          : 'not installed (optional; run `eyes-on init --watch`)',
    });
    if (!hook.managed) {
      degradations.push('no post-commit hook: assessments are computed on demand rather than in the background (this is optional, report R9)');
    }
  }

  // 5. Skill.
  const skills = inspectSkill(skillRoot(context.env));
  const staleSkill = skills.filter((entry) => !entry.present || !entry.current);
  rows.push({
    check: 'skill',
    status: staleSkill.length === 0 ? 'ok' : 'warn',
    detail:
      staleSkill.length === 0
        ? `/eyes-on installed in ${skills.length} skill bases`
        : `${staleSkill.length} of ${skills.length} skill bases are missing or stale - run \`eyes-on init\``,
  });

  // 6. Coexistence with no-mistakes.
  const coexistence = inspectCoexistence(context);
  for (const row of coexistence.rows) rows.push(row);
  degradations.push(...coexistence.degradations);

  const failures = rows.filter((row) => row.status === 'missing').length;
  const doc: ToonObject = {
    ok: failures === 0,
    checks: rows as unknown as ToonValue,
    degradations,
    help:
      failures === 0
        ? ['Everything eyes-on needs at stage 0 is present']
        : ['Fix the checks marked `missing` above, then run `eyes-on doctor` again'],
  };
  emitDoc(context.writers, context.format, doc, renderMarkdown(rows, degradations));
  return failures === 0 ? 0 : 1;
}

interface Coexistence {
  rows: Row[];
  degradations: string[];
}

/**
 * Reports on the other tool without touching it. Everything below is a stat or
 * a read: nothing under a foreign state root is written, which is the stage 0
 * acceptance test (report section 4).
 */
function inspectCoexistence(context: Context): Coexistence {
  const rows: Row[] = [];
  const degradations: string[] = [];
  const nmHome = context.env.NM_HOME && context.env.NM_HOME.length > 0
    ? context.env.NM_HOME
    : join(homedir(), '.no-mistakes');
  const nmPresent = existsSync(nmHome);

  rows.push({
    check: 'no-mistakes',
    status: 'ok',
    detail: nmPresent
      ? `${nmHome} (present; eyes-on reads nothing from it and writes nothing to it)`
      : 'not installed (eyes-on does not need it)',
  });
  if (!nmPresent) {
    degradations.push(
      'no-mistakes is not installed: nothing in eyes-on depends on it, but the optional intent import from its database is unavailable (report K20)',
    );
  }

  // Service labels. Both tools scope their label by a hash of their own state
  // root, so a collision is impossible by construction (report U4, K15) - but
  // saying so is worth less than showing the two labels side by side.
  const own = inspectService(context.paths);
  const agentsDir = join(homedir(), 'Library', 'LaunchAgents');
  let foreignLabels: string[] = [];
  if (existsSync(agentsDir)) {
    try {
      foreignLabels = readdirSync(agentsDir)
        .filter((name) => name.includes('no-mistakes') || name.includes('eyes-on'))
        .map((name) => name.replace(/\.plist$/, ''));
    } catch {
      foreignLabels = [];
    }
  }
  rows.push({
    check: 'service labels',
    status: 'ok',
    detail: foreignLabels.length > 0 ? foreignLabels.join(', ') : own.label || 'none installed',
  });

  const collision = own.label.length > 0 && foreignLabels.filter((label) => label === own.label).length > 1;
  if (collision) {
    rows.push({ check: 'service collision', status: 'missing', detail: `duplicate service label ${own.label}` });
  }

  // Socket and database paths must be distinct files. They are, by living under
  // different roots - but a misconfigured EYES_HOME could point at the wrong one.
  const nmSocket = join(nmHome, 'socket');
  const sameSocket = existsSync(nmSocket) && sameFile(nmSocket, context.paths.socket);
  const nmDb = join(nmHome, 'state.sqlite');
  const sameDb = existsSync(nmDb) && sameFile(nmDb, context.paths.db);
  if (sameSocket || sameDb) {
    rows.push({
      check: 'state isolation',
      status: 'missing',
      detail: `EYES_HOME (${context.paths.root}) resolves onto the no-mistakes state root - eyes-on refuses to share it`,
    });
  } else {
    rows.push({
      check: 'state isolation',
      status: 'ok',
      detail: `separate root, socket, database and lock from ${nmHome}`,
    });
  }

  if (context.guard.insideGate) {
    rows.push({
      check: 'recursion',
      status: 'warn',
      detail: `inside a no-mistakes run (${context.guard.detail}); eyes-on refuses to record anything here`,
    });
  }

  return { rows, degradations };
}

function sameFile(a: string, b: string): boolean {
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

const SYMBOLS: Record<Level, string> = { ok: 'ok  ', warn: 'warn', missing: 'MISS' };

function renderMarkdown(rows: Row[], degradations: string[]): string {
  const lines = ['eyes-on doctor', ''];
  for (const row of rows) {
    lines.push(`  ${SYMBOLS[row.status]}  ${row.check.padEnd(18)} ${row.detail}`);
  }
  if (degradations.length > 0) {
    lines.push('', 'Degradations:');
    for (const note of degradations) lines.push(`  - ${note}`);
  }
  return lines.join('\n');
}
