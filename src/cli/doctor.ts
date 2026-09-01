import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Context } from './context.js';
import { emitDoc } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { gitVersion, toplevel } from '../git/git.js';
import { canonicalPath, repoID } from '../core/repoid.js';
import { inspectMirror, mirrorSizeBytes } from '../git/mirror.js';
import { daemonState, daemonStatus, describeDaemon } from '../daemon/lifecycle.js';
import { inspectService, launchdPlistPath, readPlistLabelFile, type ServiceStatus } from '../daemon/service.js';
import { inspectSkill, skillRoot } from '../skill/install.js';
import { inspectPostCommitHook } from '../git/hook.js';
import { Database } from '../db/db.js';
import { foreignStateRoot, isInsideStateRoot } from '../core/paths.js';

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

export type Level = 'ok' | 'warn' | 'missing';

export interface Row {
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
  // A missing gh is a degradation, never a failure: the product is specified to
  // work without no-mistakes, without gh and without a model, and only stages
  // 2-3 lose anything. Reporting `missing` here would make `doctor` exit 1 on a
  // perfectly healthy stage 0 install.
  rows.push({
    check: 'gh',
    status: gh && ghAuth ? 'ok' : 'warn',
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
    detail: describeDaemon(state, context.paths.lockFile),
  });

  const service = inspectService(context.paths);
  rows.push({
    check: 'service',
    status: service.supported && service.installed && service.running ? 'ok' : 'warn',
    detail: service.supported
      ? `${service.label} (${service.installed ? 'installed' : 'not installed'}${serviceJobDetail(service)})`
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
  const coexistence = inspectCoexistence(context, service);
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
function inspectCoexistence(context: Context, own: ServiceStatus): Coexistence {
  const rows: Row[] = [];
  const degradations: string[] = [];
  const nmHome = foreignStateRoot(context.env);
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
  const scan = scanLaunchAgents(join(homedir(), 'Library', 'LaunchAgents'));
  const related = scan.agents.filter(
    (agent) => agent.label.includes('no-mistakes') || agent.label.includes('eyes-on'),
  );
  rows.push({
    check: 'service labels',
    status: 'ok',
    detail: related.length > 0 ? related.map((agent) => agent.label).join(', ') : own.label || 'none installed',
  });

  // A file doctor could not read is a check it could not make, so it says so
  // rather than reporting a clean result it did not earn. A file that reads
  // fine and simply declares no Label is not one of those: it names no job, so
  // it can collide with nothing, and it is not worth a word.
  if (scan.directoryError !== null) {
    rows.push({
      check: 'service labels read',
      status: 'warn',
      detail: `${scan.directory} could not be listed (${scan.directoryError}), so no service collision was checked for`,
    });
  } else if (scan.unreadable.length > 0) {
    rows.push({
      check: 'service labels read',
      status: 'warn',
      detail: `${scan.unreadable.length} LaunchAgent file(s) could not be parsed, so their labels were not compared: ${scan.unreadable
        .map((entry) => `${entry.file} (${entry.reason})`)
        .join('; ')}`,
    });
  }

  for (const row of labelCollisionRows(scan.agents, own.label, launchdPlistPath(context.paths))) {
    rows.push(row);
  }

  // Every write eyes-on makes lands under its state root, so isolation is a
  // question about one directory rather than about named files inside it: a
  // root nested anywhere under the foreign home puts config, database, mirrors,
  // logs and socket under `~/.no-mistakes/**` at once. Resolving the root
  // already refuses that (Paths), so this row reports a condition the CLI could
  // not have started with - it is reachable when NM_HOME changes, or when the
  // foreign root appears above an existing eyes-on root afterwards.
  const nested = isInsideStateRoot(context.paths.root, nmHome);
  rows.push({
    check: 'state isolation',
    status: nested ? 'missing' : 'ok',
    detail: nested
      ? `EYES_HOME (${context.paths.root}) is inside the no-mistakes state root ${nmHome} - eyes-on refuses to run with it and writes nothing there`
      : `separate root, socket, database and lock from ${nmHome}`,
  });

  if (context.guard.insideGate) {
    rows.push({
      check: 'recursion',
      status: 'warn',
      detail: `inside a no-mistakes run (${context.guard.detail}); eyes-on refuses to record anything here`,
    });
  }

  return { rows, degradations };
}

export interface DeclaredAgent {
  file: string;
  label: string;
}

export interface UnreadableAgent {
  file: string;
  reason: string;
}

export interface LaunchAgentScan {
  directory: string;
  agents: DeclaredAgent[];
  /**
   * Files that could not be parsed at all, so whatever job they declare is
   * invisible here. A file that parses and declares no `Label` is *not* one of
   * these: it was read, and the answer was "this names no job".
   */
  unreadable: UnreadableAgent[];
  /** Set when the directory itself could not be listed. */
  directoryError: string | null;
}

/** Every LaunchAgent in dir, keyed by the `Label` it actually declares. */
export function scanLaunchAgents(dir: string): LaunchAgentScan {
  const empty: LaunchAgentScan = { directory: dir, agents: [], unreadable: [], directoryError: null };
  if (!existsSync(dir)) return empty;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.plist'));
  } catch (error) {
    return { ...empty, directoryError: (error as Error).message };
  }
  const agents: DeclaredAgent[] = [];
  const unreadable: UnreadableAgent[] = [];
  for (const name of names) {
    const file = join(dir, name);
    const read = readPlistLabelFile(file);
    if (!read.ok) {
      unreadable.push({ file: name, reason: read.reason });
      continue;
    }
    if (read.label) agents.push({ file, label: read.label });
  }
  return { directory: dir, agents, unreadable, directoryError: null };
}

/** True for the labels a collision would actually cost eyes-on something. */
function ourConcern(label: string, ownLabel: string): boolean {
  return label === ownLabel || label.includes('eyes-on') || label.includes('no-mistakes');
}

/**
 * Collisions between declared service labels, at the severity each one deserves.
 *
 * A label is what the plist *declares*, not what its filename suggests: two
 * files can name the same job, and only the declared label decides which job
 * `launchctl bootout` tears down. A duplicate that names eyes-on or no-mistakes
 * is fatal, because either tool's `stop` could then tear down the other's
 * daemon. A duplicate between two unrelated third-party jobs cannot touch a
 * root-hash-scoped label, so it is reported and nothing more - doctor fails only
 * on what genuinely breaks eyes-on.
 */
export function labelCollisionRows(agents: DeclaredAgent[], ownLabel: string, ownPlist: string): Row[] {
  const rows: Row[] = [];
  const byLabel = new Map<string, string[]>();
  for (const agent of agents) {
    byLabel.set(agent.label, [...(byLabel.get(agent.label) ?? []), agent.file]);
  }
  const duplicated = new Set<string>();
  for (const [label, files] of byLabel) {
    if (files.length < 2) continue;
    duplicated.add(label);
    rows.push({
      check: 'service collision',
      status: ourConcern(label, ownLabel) ? 'missing' : 'warn',
      detail: `service label ${label} is declared by ${files.join(' and ')}`,
    });
  }
  // A single foreign file declaring the eyes-on label is not a duplicate yet,
  // and it is the worse case: `launchctl bootout` on our label would tear down
  // somebody else's job.
  const impostors = agents.filter((agent) => agent.label === ownLabel && agent.file !== ownPlist);
  if (ownLabel.length > 0 && impostors.length > 0 && !duplicated.has(ownLabel)) {
    rows.push({
      check: 'service collision',
      status: 'missing',
      detail: `${impostors.map((agent) => agent.file).join(', ')} declares the eyes-on service label ${ownLabel}`,
    });
  }
  return rows;
}

/** A loaded job with no process is not a working service, and doctor says so. */
function serviceJobDetail(service: ReturnType<typeof inspectService>): string {
  if (!service.loaded) return '';
  if (service.running) return `, loaded and running${service.pid === null ? '' : ` (pid ${service.pid})`}`;
  return ', loaded but not running - run `eyes-on init` to start it';
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
