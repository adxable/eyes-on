import { existsSync } from 'node:fs';
import type { Context } from './context.js';
import { requireRepo } from './context.js';
import { flagString } from './args.js';
import { EXIT_ERROR, UserFacingError, progress } from './output.js';
import { RepoReader } from '../git/reader.js';
import { currentBranch } from '../git/git.js';
import { repoID } from '../core/repoid.js';
import { Database } from '../db/db.js';
import { readTrustedConfig, resolveDefaultBranch, type TrustedConfig } from '../rules/trusted.js';

/**
 * What every risk command needs before it can say anything: the clone, the
 * mirror, the trusted config and the two commits the change lies between.
 *
 * Resolved in one place because the failures are the interesting part. A
 * command that cannot find a base has to say which refs it tried, and a command
 * running on a repository eyes-on has never seen has to say so without
 * pretending the answer would have been the same.
 */

export interface RiskContext {
  clonePath: string;
  repoId: string;
  reader: RepoReader;
  db: Database | null;
  trusted: TrustedConfig;
  branch: string;
  baseSHA: string;
  headSHA: string;
  /** How the base was chosen, for the provenance line. */
  baseFrom: string;
}

export type DbMode =
  /** `check` records what it computed, so a missing state root is an error. */
  | 'required'
  /** Read-only commands use the blame cache when there is one and work without
   *  it when there is not: `eyes-on why` on a machine where `init` never ran is
   *  slower, not broken. */
  | 'optional'
  | 'none';

export interface RiskContextOptions {
  dbMode?: DbMode;
  /** Resolve base and head. `why` and `export-path-instructions` do not need a
   *  change at all: they describe the repository, not a diff. */
  needRange?: boolean;
}

export function riskContext(context: Context, options: RiskContextOptions = {}): RiskContext {
  const clonePath = requireRepo(context);
  const id = repoID(clonePath);
  const reader = new RepoReader({ clonePath, mirrorPath: context.paths.mirrorDir(id) });

  const db = openDatabase(context, options.dbMode ?? 'required');
  const trusted = readTrustedConfig(clonePath, reader, flagString(context.args, 'default-branch'));
  if (trusted.state === 'unverified') {
    // Progress, not an error: the check still produces a score, and the payload
    // carries `config_state: unverified` so an agent can see the assessment is
    // incomplete rather than merely quiet.
    progress(context.writers, `warning: ${trusted.detail ?? 'the trusted configuration could not be read'}`);
  }

  const range = options.needRange === false ? null : resolveRange(context, clonePath, reader);

  return {
    clonePath,
    repoId: id,
    reader,
    db,
    trusted,
    branch: currentBranch(clonePath) ?? 'detached',
    baseSHA: range?.baseSHA ?? '',
    headSHA: range?.headSHA ?? '',
    baseFrom: range?.baseFrom ?? '',
  };
}

/**
 * Opens the state database, or explains that eyes-on has not been set up here.
 *
 * The message names the state root it looked in, because the single most
 * common way to see it is a command run with a different `EYES_HOME` than the
 * one `init` used.
 */
function openDatabase(context: Context, mode: DbMode): Database | null {
  if (mode === 'none') return null;
  if (!existsSync(context.paths.db)) {
    if (mode === 'optional') return null;
    throw new UserFacingError(
      `no eyes-on state at ${context.paths.root}`,
      [
        'Run `eyes-on init` in this repository first',
        `If eyes-on was set up under a different state root, set EYES_HOME to it (currently ${context.paths.root})`,
      ],
      EXIT_ERROR,
    );
  }
  return Database.open(context.paths.db);
}

interface Range {
  baseSHA: string;
  headSHA: string;
  baseFrom: string;
}

function resolveRange(context: Context, clonePath: string, reader: RepoReader): Range {
  const headRef = flagString(context.args, 'head') ?? 'HEAD';
  const headSHA = reader.resolve(headRef);
  if (!headSHA) {
    throw new UserFacingError(`cannot resolve --head ${headRef} in ${clonePath}`, [
      'Pass a branch, tag or commit that exists in this clone',
    ]);
  }

  const requestedBase = flagString(context.args, 'base');
  if (requestedBase) {
    const baseSHA = reader.resolve(requestedBase);
    if (!baseSHA) {
      throw new UserFacingError(`cannot resolve --base ${requestedBase} in ${clonePath}`, [
        'Pass a branch, tag or commit that exists in this clone',
      ]);
    }
    const merge = reader.mergeBase(baseSHA, headSHA);
    // An explicit base is honoured as given unless it is an ancestor's
    // descendant - taking the merge base keeps `--base main` meaning "what this
    // branch adds" rather than "everything main has that I do not".
    return { baseSHA: merge ?? baseSHA, baseFrom: `--base ${requestedBase}`, headSHA };
  }

  const defaultBranch = resolveDefaultBranch(clonePath, reader, flagString(context.args, 'default-branch'));
  if (defaultBranch) {
    const merge = reader.mergeBase(defaultBranch.sha, headSHA);
    if (merge && merge !== headSHA) {
      return { baseSHA: merge, baseFrom: `merge base with ${defaultBranch.ref}`, headSHA };
    }
    if (merge === headSHA) {
      // On the default branch itself, or on a branch it has caught up with:
      // the change under assessment is the last commit.
      const parent = reader.resolve(`${headSHA}^`);
      if (parent) {
        return { baseSHA: parent, baseFrom: `parent of ${headSHA.slice(0, 12)} (head is on ${defaultBranch.branch})`, headSHA };
      }
    }
  }

  const parent = reader.resolve(`${headSHA}^`);
  if (parent) {
    return { baseSHA: parent, baseFrom: `parent of ${headSHA.slice(0, 12)}`, headSHA };
  }
  // A repository with one commit. The diff against the empty tree would be the
  // whole repository, which is not a change anybody made; an empty range says
  // so honestly.
  return { baseSHA: headSHA, baseFrom: 'no parent commit: nothing to compare against', headSHA };
}
