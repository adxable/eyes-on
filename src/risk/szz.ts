import type { RepoReader } from '../git/reader.js';
import { parseRemovedRanges, type CommitRecord } from '../git/reader.js';
import type { Database } from '../db/db.js';

/**
 * SZZ-lite: which files keep attracting fixes.
 *
 * The full SZZ algorithm links a bug report to the commit that induced it.
 * This is the cheap half of it, and the report says so plainly (section 5, P1):
 * for every commit that looks like a fix, take the hunks that *removed*
 * content, blame those exact lines on the fix's parent, and record which files
 * the blame lands in.
 *
 * Three details decide whether the number means anything.
 *
 *   - **Removals only.** A line that was deleted or rewritten is the line the
 *     fix says was wrong. Additions point at nothing, and counting them would
 *     silently turn this into a second churn signal.
 *   - **Blame on the parent, not on the fix.** After the fix lands, the lines
 *     it removed are gone; only `<fix>^` still has them.
 *   - **One count per fix per file.** A fix that rewrites forty lines of one
 *     file is one piece of evidence about that file, not forty. Counting lines
 *     would let a single reformatting-shaped fix saturate the signal (K = 5) on
 *     its own.
 *
 * The cost is real - the reference measurement is 12.7 s over 271 commits - so
 * the result is cached per fix commit SHA in `blame_cache`. A commit's blame
 * never changes once it exists, which is what makes the cache correct rather
 * than merely fast: the second run walks only commits it has not seen.
 */

/** What one fix commit tells us. Serialised into `blame_cache.payload`. */
export interface FixAttribution {
  /** Commit that was recognised as a fix. */
  sha: string;
  timestamp: number;
  subject: string;
  /** Files whose removed lines this fix blamed into, with the number of blamed
   *  lines - kept for `why`, which shows the evidence rather than the score. */
  files: Record<string, number>;
  /** Commits blame named as having introduced those lines. Stage 3 (`leaks`)
   *  needs the mapping; stage 1 stores it because it is free here and would
   *  cost a second full walk later. */
  introducers: Record<string, number>;
}

const CACHE_VERSION = 1;

interface CachePayload {
  v: number;
  files: Record<string, number>;
  introducers: Record<string, number>;
}

/**
 * Recognises a fix commit.
 *
 * Two shapes count. The configured subject pattern is the ordinary one
 * (`fix:`, `hotfix(...)`, `fix!:`). A revert is the other, and it is recognised
 * from git's own generated subject rather than from a convention: a revert is
 * the strongest possible statement that the reverted change was wrong.
 */
export function isFixCommit(commit: CommitRecord, pattern: RegExp): boolean {
  const subject = commit.subject.trim();
  if (pattern.test(subject)) return true;
  return /^revert[\s:"']/i.test(subject);
}

export interface SzzOptions {
  reader: RepoReader;
  /** Opened state database, or null to run without a cache. `backtest` runs
   *  without one deliberately: it replays history at many split dates and must
   *  not leave the cache shaped like whichever split ran last. */
  db: Database | null;
  fixPattern: RegExp;
  /** Called once per commit actually blamed, so a long first run can report
   *  progress on stderr instead of looking wedged. */
  onProgress?: (done: number, total: number) => void;
}

export interface SzzResult {
  attributions: FixAttribution[];
  /** How many of the fix commits were answered from the cache. The cost
   *  acceptance condition is a statement about this number. */
  cached: number;
  computed: number;
}

/**
 * Runs SZZ-lite over a list of commits, newest first or oldest first - order
 * does not matter, because each commit is analysed against its own parent.
 */
export function attributeFixes(commits: readonly CommitRecord[], options: SzzOptions): SzzResult {
  const fixes = commits.filter((commit) => isFixCommit(commit, options.fixPattern));
  const attributions: FixAttribution[] = [];
  let cached = 0;
  let computed = 0;

  for (const fix of fixes) {
    const fromCache = readCache(options.db, fix.sha);
    if (fromCache) {
      cached += 1;
      attributions.push({ sha: fix.sha, timestamp: fix.timestamp, subject: fix.subject, ...fromCache });
      options.onProgress?.(cached + computed, fixes.length);
      continue;
    }
    const measured = blameFix(options.reader, fix);
    computed += 1;
    writeCache(options.db, fix.sha, measured);
    attributions.push({ sha: fix.sha, timestamp: fix.timestamp, subject: fix.subject, ...measured });
    options.onProgress?.(cached + computed, fixes.length);
  }

  return { attributions, cached, computed };
}

/** The blame work for one fix commit. Exported for the tests that prove the
 *  cache returns the same answer the computation does. */
export function blameFix(
  reader: RepoReader,
  fix: CommitRecord,
): { files: Record<string, number>; introducers: Record<string, number> } {
  const files: Record<string, number> = {};
  const introducers: Record<string, number> = {};
  const parent = fix.parents[0];
  // A root commit removes nothing: there is no parent to blame.
  if (!parent) return { files, introducers };

  let patch: string;
  try {
    patch = reader.commitPatch(fix.sha);
  } catch {
    // A commit whose patch git will not produce (a broken object in a partial
    // clone, most often) contributes nothing rather than stopping the walk.
    return { files, introducers };
  }

  for (const range of parseRemovedRanges(patch)) {
    const blamed = reader.blame(parent, range.path, range.start, range.end);
    if (blamed.length === 0) continue;
    files[range.path] = (files[range.path] ?? 0) + blamed.length;
    for (const sha of blamed) {
      introducers[sha] = (introducers[sha] ?? 0) + 1;
    }
  }
  return { files, introducers };
}

function readCache(db: Database | null, sha: string): { files: Record<string, number>; introducers: Record<string, number> } | null {
  if (!db) return null;
  const row = db.get<{ payload: string }>('SELECT payload FROM blame_cache WHERE commit_sha = ?', sha);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload) as CachePayload;
    // A payload from an older shape is a miss, not a failure: it is recomputed
    // and overwritten. The cache is a cache.
    if (parsed.v !== CACHE_VERSION) return null;
    return { files: parsed.files ?? {}, introducers: parsed.introducers ?? {} };
  } catch {
    return null;
  }
}

function writeCache(
  db: Database | null,
  sha: string,
  value: { files: Record<string, number>; introducers: Record<string, number> },
): void {
  if (!db) return;
  const payload: CachePayload = { v: CACHE_VERSION, files: value.files, introducers: value.introducers };
  db.run(
    'INSERT INTO blame_cache (commit_sha, payload) VALUES (?, ?) ON CONFLICT(commit_sha) DO UPDATE SET payload = excluded.payload',
    sha,
    JSON.stringify(payload),
  );
}

/**
 * Per-file fix counts: how many distinct fix commits blamed into each file.
 *
 * This, not the line count, is the S1 raw value. See the header for why.
 */
export function fixCountsByFile(attributions: readonly FixAttribution[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const attribution of attributions) {
    for (const path of Object.keys(attribution.files)) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return counts;
}
