import type { Database } from '../db/db.js';
import type { RepoReader } from '../git/reader.js';
import { fileFilter } from './files.js';
import { readHistory, indexByFile } from './history.js';
import type { RepoConfig } from './repoconfig.js';
import { attributeFixes, fixCountsByFile, isFixCommit } from './szz.js';

/**
 * Backtesting the signal against the repository's own history.
 *
 * The question is the only one worth asking of a risk signal: **if I had
 * computed it on the day before the split, would it have pointed at the files
 * that went on to need fixing?** Everything here is arranged so that question
 * cannot be answered by accident.
 *
 *   - The signal is computed from commits **strictly before** the split, over
 *     the same window `check` uses, so a good result is a statement about the
 *     live signal rather than about a differently-shaped offline one.
 *   - The outcome is measured from commits **strictly after** it.
 *   - The population is the code files that **existed at the split**. A file
 *     created afterwards could never have been flagged, and leaving it in the
 *     denominator would make every signal look better than it is.
 *   - The outcome is "a fix commit touched this file", read from `--numstat`
 *     rather than from blame. Blame is how the *signal* is built; using it for
 *     the outcome as well would let one implementation detail decide both sides
 *     of the comparison.
 *
 * The number reported is a lift: how much more often a flagged file was fixed
 * than the average file. A lift of 1.0 means the signal knows nothing.
 */

export interface SplitResult {
  split: string;
  split_seconds: number;
  split_commit: string | null;
  /** Code files present at the split. */
  population: number;
  /** Commits in the pre-split window, and the fixes among them. */
  before_commits: number;
  before_fix_commits: number;
  after_commits: number;
  after_fix_commits: number;
  /** Fix touches after the split, per file, averaged over the population. */
  base_rate: number;
  fix_history: GroupResult;
  /**
   * The same measurement over a deliberately weaker flag: files a fix commit
   * merely *touched* before the split, with no blame step.
   *
   * It is reported beside the real signal rather than instead of it, because
   * the two answer different questions. `fix_history` measures what eyes-on
   * actually computes; this measures what the cheapest possible version of the
   * signal would have achieved. Where the cheap one does as well, the blame
   * step is buying nothing on this repository - which is a fact worth seeing
   * rather than one worth hiding, and is what `calibrate` will act on in stage
   * 3.
   */
  fix_touch: GroupResult;
  churn_top_decile: GroupResult;
  elapsed_ms: number;
  /** Set when the split cannot be evaluated - too early, too late, or a
   *  repository with nothing either side of it. Never a silent zero. */
  note: string | null;
}

/** One flagged file and how it behaved either side of the split. */
export interface GroupExample {
  path: string;
  before: number;
  after: number;
}

/**
 * What one signal did on one split, and - when it did nothing - why.
 *
 * The status is a value, not something a reader infers from a null or a zero.
 * Three rounds of this file's history were spent getting that inference wrong
 * at the rendering site, each time in a new way: a lift of `null` has two
 * different causes, a `flagged` of `0` is sometimes a real count and sometimes
 * a placeholder, and neither is legible from the number alone.
 *
 *   - `measured` - the flagging step ran and the lift has a value. Every field
 *     is a number.
 *   - `no-lift` - the flagging step ran, so `flagged` is a real count and
 *     `rate` is real whenever it has a value, but the ratio does not: either
 *     nothing was flagged (the numerator averages over an empty set) or the
 *     base rate is zero (the denominator is).
 *   - `not-run` - the split never got as far as flagging anything, so every
 *     number here is null rather than zero.
 */
export type GroupResult =
  | {
      status: 'measured';
      reason: null;
      flagged: number;
      rate: number;
      lift: number;
      examples: GroupExample[];
    }
  | {
      status: 'no-lift';
      reason: string;
      flagged: number;
      rate: number | null;
      lift: null;
      examples: GroupExample[];
    }
  | {
      status: 'not-run';
      reason: string;
      flagged: null;
      rate: null;
      lift: null;
      examples: GroupExample[];
    };

export interface BacktestOptions {
  reader: RepoReader;
  db: Database | null;
  config: RepoConfig;
  /** Commit the whole replay is anchored to - normally the default branch head. */
  anchorSHA: string;
  splits: string[];
  /** Days after the split to measure the outcome over. Undefined means "to the
   *  anchor", which is the honest default when nobody has asked for a horizon. */
  horizonDays?: number;
  onProgress?: (message: string) => void;
}

export function backtest(options: BacktestOptions): SplitResult[] {
  return options.splits.map((split) => runSplit(split, options));
}

/** Parses a `YYYY-MM-DD` split date into seconds, or throws with the shape it
 *  wanted. Deliberately strict: `--split june` silently parsed as something is
 *  how a backtest ends up reporting a window nobody chose. */
export function parseSplit(value: string): number {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`split date ${JSON.stringify(value)} is not YYYY-MM-DD`);
  }
  const parsed = Date.parse(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    throw new Error(`split date ${JSON.stringify(value)} is not a real date`);
  }
  return Math.floor(parsed / 1000);
}

function runSplit(split: string, options: BacktestOptions): SplitResult {
  const started = process.hrtime.bigint();
  const splitSeconds = parseSplit(split);
  const { config, reader } = options;
  const filter = fileFilter(config);
  const fixPattern = new RegExp(config.fix_commit_pattern);

  // A split the replay could not get through: the same reason on the split and
  // on all three of its signals, because none of them ran.
  const notRun = (reason: string, known: Partial<SplitResult> = {}): SplitResult => ({
    split,
    split_seconds: splitSeconds,
    split_commit: null,
    population: 0,
    before_commits: 0,
    before_fix_commits: 0,
    after_commits: 0,
    after_fix_commits: 0,
    base_rate: 0,
    fix_history: notRunGroup(reason),
    fix_touch: notRunGroup(reason),
    churn_top_decile: notRunGroup(reason),
    elapsed_ms: elapsed(started),
    note: reason,
    ...known,
  });

  const splitCommit = reader.lastCommitBefore(options.anchorSHA, splitSeconds);
  if (!splitCommit) {
    return notRun('no commit on this branch is older than the split date');
  }

  // --- the signal, from before the split only -------------------------------
  const before = readHistory({
    reader,
    headSHA: splitCommit,
    windowDays: config.history_window_days,
    nowSeconds: splitSeconds,
  });
  options.onProgress?.(`${split}: ${before.commits.length} commits in the pre-split window`);

  const szz = attributeFixes(before.commits, {
    reader,
    db: options.db,
    fixPattern,
    onProgress: (done, total) => {
      if (done === total || done % 25 === 0) options.onProgress?.(`${split}: blaming ${done}/${total}`);
    },
  });
  const fixCounts = fixCountsByFile(szz.attributions);
  const fixTouches = indexByFile(before.commits.filter((commit) => isFixCommit(commit, fixPattern)));

  // --- the outcome, from after the split only -------------------------------
  const afterUntil = options.horizonDays === undefined ? undefined : splitSeconds + options.horizonDays * 86_400;
  const afterCommits = reader
    .history({ sinceSeconds: splitSeconds, untilSeconds: afterUntil, until: options.anchorSHA })
    .filter((commit) => commit.timestamp > splitSeconds);
  const afterFixes = afterCommits.filter((commit) => isFixCommit(commit, fixPattern));
  const afterFixTouches = indexByFile(afterFixes);

  // --- the population: code files that existed at the split -----------------
  const population = reader.filesAt(splitCommit).filter((path) => filter.isCode(path));
  if (population.length === 0 || afterCommits.length === 0) {
    return notRun(
      population.length === 0
        ? 'no code files existed at the split date under the trusted include patterns'
        : `no commits landed in the outcome window (after ${split}${
            options.horizonDays === undefined ? ', up to the branch head' : `, within ${options.horizonDays} days`
          }): there is no outcome to measure`,
      {
        split_commit: splitCommit,
        population: population.length,
        before_commits: before.commits.length,
        before_fix_commits: szz.attributions.length,
        after_commits: afterCommits.length,
        after_fix_commits: afterFixes.length,
      },
    );
  }

  const outcome = (path: string): number => afterFixTouches.get(path)?.commits ?? 0;
  const totalAfter = population.reduce((sum, path) => sum + outcome(path), 0);
  const baseRate = totalAfter / population.length;

  const flaggedByFixes = population.filter((path) => (fixCounts.get(path) ?? 0) >= 1);
  const flaggedByTouch = population.filter((path) => (fixTouches.get(path)?.commits ?? 0) >= 1);
  const churnRanked = [...population].sort(
    (a, b) => (before.files.get(b)?.commits ?? 0) - (before.files.get(a)?.commits ?? 0) || a.localeCompare(b),
  );
  // The top decile, never fewer than one file: a repository of eight files has
  // a top decile too, and rounding it to zero would report a lift of NaN.
  const decileSize = Math.max(1, Math.floor(population.length / 10));
  const topDecile = churnRanked
    .slice(0, decileSize)
    .filter((path) => (before.files.get(path)?.commits ?? 0) > 0);

  const group = (paths: string[], before_: (path: string) => number): GroupResult => {
    const examples = paths
      .map((path) => ({ path, before: before_(path), after: outcome(path) }))
      .sort((a, b) => b.after - a.after || b.before - a.before)
      .slice(0, 5);
    // Flagging nothing is a real count of zero, not an absent step: the signal
    // ran and had nothing to say. What it has no value for is the ratio.
    if (paths.length === 0) {
      return {
        status: 'no-lift',
        reason: 'this signal flagged no file before the split, so its rate averages over an empty set',
        flagged: 0,
        rate: null,
        lift: null,
        examples,
      };
    }
    const total = paths.reduce((sum, path) => sum + outcome(path), 0);
    const rate = total / paths.length;
    if (baseRate === 0) {
      return {
        status: 'no-lift',
        reason:
          'no fix commit after the split touched any file that existed at it, so the base rate this lift divides by is zero',
        flagged: paths.length,
        rate,
        lift: null,
        examples,
      };
    }
    return { status: 'measured', reason: null, flagged: paths.length, rate, lift: rate / baseRate, examples };
  };

  const fixHistory = group(flaggedByFixes, (path) => fixCounts.get(path) ?? 0);
  const fixTouch = group(flaggedByTouch, (path) => fixTouches.get(path)?.commits ?? 0);
  const churnDecile = group(topDecile, (path) => before.files.get(path)?.commits ?? 0);

  return {
    split,
    split_seconds: splitSeconds,
    split_commit: splitCommit,
    population: population.length,
    before_commits: before.commits.length,
    before_fix_commits: szz.attributions.length,
    after_commits: afterCommits.length,
    after_fix_commits: afterFixes.length,
    base_rate: baseRate,
    fix_history: fixHistory,
    fix_touch: fixTouch,
    churn_top_decile: churnDecile,
    elapsed_ms: elapsed(started),
    // The replay itself got through. Whether any signal could be measured is a
    // per-signal question, and each group answers it for itself rather than
    // being summarised into one sentence here.
    note: null,
  };
}

function notRunGroup(reason: string): GroupResult {
  return { status: 'not-run', reason, flagged: null, rate: null, lift: null, examples: [] };
}

function elapsed(started: bigint): number {
  return Math.round(Number(process.hrtime.bigint() - started) / 1e6);
}

/** The acceptance thresholds from the report (section 8, stage 1). They live
 *  here so `backtest` can say pass or fail rather than leaving a reader to
 *  compare two numbers by hand. */
export const FIX_HISTORY_LIFT_TARGET = 2.5;
export const CHURN_DECILE_LIFT_TARGET = 3.0;
