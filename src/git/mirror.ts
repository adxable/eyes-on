import { existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, commonGitDir } from './git.js';

/**
 * The mirror: a bare repository at `<root>/mirrors/<repoID>.git` whose
 * `objects/info/alternates` points at the working clone's object store.
 *
 * This is report D2 - the one place where eyes-on takes no-mistakes' bare-repo
 * idea and inverts it. no-mistakes' bare repo is a gate that *accepts a push*;
 * eyes-on's is a mirror it only ever fetches into. The measured difference is
 * the whole argument: on adx-worker a full `clone --bare --no-hardlinks` costs
 * 2.13 s and 87 MB, while a bare repo on alternates costs 0.11 s and 272 KB,
 * and `git log` and `git blame --line-porcelain` both work through it
 * (report Appendix A4, D.4).
 *
 * Two consequences follow and both are deliberate:
 *
 *   - eyes-on gets a private, stable namespace of refs it fully owns, so it
 *     never writes a ref into the captain's clone (K1). Fetched heads land in
 *     `refs/remotes/clone/*` inside the mirror, nowhere else.
 *   - the mirror borrows objects rather than copying them, so deleting the
 *     clone breaks it. That makes the mirror a rebuildable cache, never state:
 *     `doctor` detects a broken mirror and `init` rebuilds it.
 */

export const MIRROR_REFSPEC = '+refs/heads/*:refs/remotes/clone/*';

export interface MirrorStatus {
  path: string;
  exists: boolean;
  /** Object store the alternates file points at. */
  alternate: string | null;
  /** True when the alternate path is present on disk. */
  alternateReachable: boolean;
  refs: number;
}

function alternatesFile(mirrorPath: string): string {
  return join(mirrorPath, 'objects', 'info', 'alternates');
}

function readAlternate(mirrorPath: string): string | null {
  try {
    const value = readFileSync(alternatesFile(mirrorPath), 'utf8').trim();
    return value.length > 0 ? value.split(/\r?\n/)[0] ?? null : null;
  } catch {
    return null;
  }
}

export function inspectMirror(mirrorPath: string): MirrorStatus {
  if (!existsSync(join(mirrorPath, 'HEAD'))) {
    return { path: mirrorPath, exists: false, alternate: null, alternateReachable: false, refs: 0 };
  }
  const alternate = readAlternate(mirrorPath);
  const refs = git(['for-each-ref', '--format=%(refname)', 'refs/remotes/clone'], { gitDir: mirrorPath });
  return {
    path: mirrorPath,
    exists: true,
    alternate,
    alternateReachable: alternate !== null && existsSync(alternate),
    refs: refs.status === 0 ? refs.stdout.split('\n').filter((line) => line.trim().length > 0).length : 0,
  };
}

export interface EnsureMirrorResult {
  status: MirrorStatus;
  created: boolean;
  repaired: boolean;
  fetchMs: number;
}

/**
 * Creates the mirror if missing, repairs it if its alternate has drifted or
 * broken, and fetches the clone's heads into it. Idempotent: on an intact
 * mirror this is a fetch and nothing else.
 */
export function ensureMirror(mirrorPath: string, clonePath: string, options: { force?: boolean } = {}): EnsureMirrorResult {
  const common = commonGitDir(clonePath);
  if (!common) {
    throw new Error(`cannot resolve the git object store of ${clonePath}`);
  }
  // The clone's *common* dir, so a linked worktree resolves to the shared
  // object store rather than its own object-less git dir.
  const alternate = join(common, 'objects');
  let created = false;
  let repaired = false;

  const before = inspectMirror(mirrorPath);
  if (options.force && before.exists) {
    rmSync(mirrorPath, { recursive: true, force: true });
  }
  if (!existsSync(join(mirrorPath, 'HEAD'))) {
    mkdirSync(mirrorPath, { recursive: true });
    git(['init', '--bare', '--quiet', mirrorPath], { check: true });
    created = true;
    // A mirror that repacks would start copying the borrowed objects it exists
    // to avoid, and an auto-gc racing the clone's own gc is the one way a
    // read-only tool could corrupt somebody's day.
    git(['config', 'gc.auto', '0'], { gitDir: mirrorPath, check: true });
    git(['config', 'gc.autoDetach', 'false'], { gitDir: mirrorPath, check: true });
  }

  mkdirSync(join(mirrorPath, 'objects', 'info'), { recursive: true });
  if (readAlternate(mirrorPath) !== alternate) {
    writeFileSync(alternatesFile(mirrorPath), `${alternate}\n`, { mode: 0o644 });
    repaired = !created;
  }

  const started = process.hrtime.bigint();
  git(['fetch', '--quiet', '--no-tags', '--prune', clonePath, MIRROR_REFSPEC], { gitDir: mirrorPath, check: true });
  const fetchMs = Number(process.hrtime.bigint() - started) / 1e6;

  return { status: inspectMirror(mirrorPath), created, repaired, fetchMs };
}

/** Total size of the mirror in bytes, for `doctor` and the cost test. */
export function mirrorSizeBytes(mirrorPath: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          total += statSync(full).size;
        } catch {
          // A file vanishing under us during a size walk is not an error.
        }
      }
    }
  };
  walk(mirrorPath);
  return total;
}
