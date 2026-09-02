import type { CommitRecord, RepoReader } from '../git/reader.js';
import type { FileFilter } from './files.js';

/**
 * The history window, reduced to one record per file.
 *
 * Everything here comes from a single `git log --numstat` walk, because the
 * alternative - one `git log` per changed file - is the difference between a
 * check that costs a second and one that costs a minute on a repository with a
 * real history.
 */

export interface FileHistory {
  path: string;
  /** Commits in the window that touched this file (merges excluded upstream). */
  commits: number;
  /** Lines added and removed across those commits. */
  added: number;
  deleted: number;
  /** Author timestamp of the most recent commit touching it, in seconds. */
  lastTouched: number;
  /** Distinct commit subjects, newest first, capped: `why` shows a handful and
   *  keeping every subject of a hot file in memory buys nothing. */
  recentSubjects: { sha: string; timestamp: number; subject: string }[];
}

const SUBJECTS_KEPT = 8;

export interface HistoryWindow {
  /** Commits in the window, newest first. */
  commits: CommitRecord[];
  /** Per-file record, code files and others alike: the filter is applied by
   *  the caller, because `rules` and `export` need the unfiltered view. */
  files: Map<string, FileHistory>;
  /** The window's own boundaries, so a report can state what it measured. */
  sinceSeconds: number;
  untilSHA: string;
}

export interface WindowOptions {
  reader: RepoReader;
  /** Commit the window ends at. */
  headSHA: string;
  windowDays: number;
  /** "Now" for the window, in seconds. A backtest passes its split date here so
   *  the window is the one that existed then, not the one that exists today. */
  nowSeconds: number;
  maxCommits?: number;
}

export function readHistory(options: WindowOptions): HistoryWindow {
  const sinceSeconds = options.nowSeconds - options.windowDays * 86_400;
  const commits = options.reader.history({
    sinceSeconds,
    // Bounded on both sides. A backtest's anchor commit is today's head, so
    // without an upper bound the "before the split" window would quietly
    // include everything that happened after it - which is the one mistake that
    // makes a backtest report a signal that does not exist.
    untilSeconds: options.nowSeconds,
    until: options.headSHA,
    maxCount: options.maxCommits,
  });
  // `--since` walks by commit date and stops at the first commit older than the
  // bound, so a repository with out-of-order dates can hand back a commit past
  // the window. Filtering by author time here makes the window mean the same
  // thing for `check` and for `backtest`, which is what lets a backtest result
  // say anything about the live signal.
  const inWindow = commits.filter(
    (commit) => commit.timestamp >= sinceSeconds && commit.timestamp <= options.nowSeconds,
  );
  return {
    commits: inWindow,
    files: indexByFile(inWindow),
    sinceSeconds,
    untilSHA: options.headSHA,
  };
}

export function indexByFile(commits: readonly CommitRecord[]): Map<string, FileHistory> {
  const files = new Map<string, FileHistory>();
  for (const commit of commits) {
    for (const file of commit.files) {
      let record = files.get(file.path);
      if (!record) {
        record = {
          path: file.path,
          commits: 0,
          added: 0,
          deleted: 0,
          lastTouched: 0,
          recentSubjects: [],
        };
        files.set(file.path, record);
      }
      record.commits += 1;
      record.added += file.added;
      record.deleted += file.deleted;
      if (commit.timestamp > record.lastTouched) record.lastTouched = commit.timestamp;
      if (record.recentSubjects.length < SUBJECTS_KEPT) {
        record.recentSubjects.push({ sha: commit.sha, timestamp: commit.timestamp, subject: commit.subject });
      }
    }
  }
  for (const record of files.values()) {
    record.recentSubjects.sort((a, b) => b.timestamp - a.timestamp);
  }
  return files;
}

/** Files in the window that the filter calls code, hottest first. The top of
 *  this list is what the noise-filter acceptance condition inspects. */
export function codeFiles(window: HistoryWindow, filter: FileFilter): FileHistory[] {
  return [...window.files.values()]
    .filter((file) => filter.isCode(file.path))
    .sort((a, b) => b.commits - a.commits);
}
