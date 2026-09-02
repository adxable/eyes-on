import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './db.js';
import { latestDecision } from './gate.js';
import type { Assessment } from '../risk/assess.js';
import type { Paths } from '../core/paths.js';

/**
 * Recording an assessment (report Appendix C.2).
 *
 * A check is identified by the repository and the two commits it spans, so
 * re-running `check` on an unchanged head updates one row instead of
 * accumulating a row per invocation. The intent is recorded on that row rather
 * than being part of its identity, so the last one given wins.
 *
 * The id is derived rather than random for the same reason: stage 2's gate and
 * stage 3's ledger both have to find the assessment of a given head again, and
 * a random id would make that a lookup by timestamp - which is the kind of
 * thing that works until two runs land in the same second.
 */

export function checkID(repoId: string, baseSHA: string, headSHA: string): string {
  return createHash('sha256').update(`${repoId} ${baseSHA} ${headSHA}`).digest('hex').slice(0, 16);
}

export interface CheckRow {
  id: string;
  repo_id: string;
  branch: string;
  base_sha: string;
  head_sha: string;
  score: number | null;
  /** The maximum `score` could have reached under the weights it was computed
   *  with. Null on a row written before eyes-on recorded it. */
  score_max: number | null;
  band: string | null;
  drift: number | null;
  intent: string | null;
  intent_source: string | null;
  status: string;
  trusted_config_sha: string | null;
  created_at: number;
  updated_at: number;
}

export interface RecordOptions {
  repoId: string;
  branch: string;
  intent: string | null;
  assessment: Assessment;
  /**
   * The drift grade folded into this score, or null when drift was not measured
   * for this run. Recorded on the row so the pull-request comment and the stage
   * 3 ledger read one number rather than recomputing it.
   *
   * Null overwrites an earlier grade rather than being merged around, and that
   * is deliberate: the score on this row was computed without S7, so a grade
   * left over from an earlier run would sit beside a number that does not
   * contain it. A caller that wants to keep a grade it did not measure - which
   * is what `spotlight` does - reads the row first and passes it back.
   */
  drift?: number | null;
}

/**
 * Writes the check, its signals and its rule hits.
 *
 * `status` distinguishes the outcomes a caller has to tell apart: `done` for a
 * complete assessment, `unverified` when the trusted config could not be read
 * (so the hard rules were never evaluated), and `must_read` for a run parked by
 * the gate.
 *
 * The park is computed here rather than passed in, so every writer of a check
 * agrees on what parks one: a hard rule fired and no decision has been recorded
 * for this check yet. A check that was already answered stays `done` when it is
 * recomputed on the same head - re-running `check` must not silently reopen a
 * gate somebody has already closed.
 */
export function recordCheck(db: Database, options: RecordOptions): string {
  const { assessment } = options;
  const id = checkID(options.repoId, assessment.base_sha, assessment.head_sha);
  const now = Math.floor(Date.now() / 1000);
  const status = statusFor(db, id, assessment);

  db.run(
    `INSERT INTO checks (id, repo_id, branch, base_sha, head_sha, score, score_max, band, drift, intent, intent_source,
                         status, trusted_config_sha, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       branch = excluded.branch,
       score = excluded.score,
       score_max = excluded.score_max,
       band = excluded.band,
       drift = excluded.drift,
       intent = excluded.intent,
       intent_source = excluded.intent_source,
       status = excluded.status,
       trusted_config_sha = excluded.trusted_config_sha,
       updated_at = excluded.updated_at`,
    id,
    options.repoId,
    options.branch,
    assessment.base_sha,
    assessment.head_sha,
    assessment.score,
    assessment.score_max,
    assessment.band,
    options.drift ?? null,
    options.intent,
    options.intent === null ? null : 'flag',
    status,
    assessment.config_sha,
    now,
    now,
  );

  db.run('DELETE FROM signals WHERE check_id = ?', id);
  for (const signal of assessment.signals) {
    db.run(
      'INSERT INTO signals (check_id, name, raw, normalized) VALUES (?, ?, ?, ?)',
      id,
      signal.name,
      signal.raw,
      signal.normalized,
    );
  }

  db.run('DELETE FROM hits WHERE check_id = ?', id);
  for (const hit of assessment.hard_rules) {
    for (const file of hit.matched_files) {
      db.run('INSERT INTO hits (check_id, glob, file, why) VALUES (?, ?, ?, ?)', id, hit.glob, file, hit.why);
    }
  }

  return id;
}

/**
 * Whether this check is parked.
 *
 * `unverified` wins over the gate: eyes-on could not read the trusted config,
 * so it does not know which paths a human was supposed to be sent to, and
 * parking on rules it never evaluated would claim a certainty it does not have.
 */
export function statusFor(db: Database, id: string, assessment: Assessment): string {
  if (assessment.config_state === 'unverified') return 'unverified';
  if (assessment.hard_rules.length === 0) return 'done';
  return latestDecision(db, id) ? 'done' : 'must_read';
}

/** The check recorded for a change, by the two commits it spans. */
export function findCheck(db: Database, repoId: string, baseSHA: string, headSHA: string): CheckRow | undefined {
  return checkByID(db, checkID(repoId, baseSHA, headSHA));
}

export function checkByID(db: Database, id: string): CheckRow | undefined {
  return db.get<CheckRow>('SELECT * FROM checks WHERE id = ?', id);
}

/** The most recent assessment of a branch, for `eyes-on` with no subcommand. */
export function latestCheck(db: Database, repoId: string, branch: string): CheckRow | undefined {
  return db.get<CheckRow>(
    'SELECT * FROM checks WHERE repo_id = ? AND branch = ? ORDER BY updated_at DESC LIMIT 1',
    repoId,
    branch,
  );
}

/**
 * Writes the full report next to the state, keeping the newest `retention`
 * files (Appendix C.2: 200).
 *
 * The database row is the index; this file is the whole assessment, including
 * the per-file detail no column holds. Pruning is by modification time and runs
 * on every write, so a machine that checks a hundred branches a day does not
 * grow a reports directory forever.
 */
export function writeReport(paths: Paths, headSHA: string, payload: unknown, retention: number): string {
  mkdirSync(paths.reportsDir, { recursive: true });
  const file = paths.reportFile(headSHA);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
  pruneReports(paths.reportsDir, retention);
  return file;
}

function pruneReports(dir: string, retention: number): void {
  if (retention <= 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  if (entries.length <= retention) return;
  const withTime = entries
    .map((name) => {
      try {
        return { name, mtime: statSync(join(dir, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { name: string; mtime: number } => entry !== null)
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of withTime.slice(retention)) {
    rmSync(join(dir, stale.name), { force: true });
  }
}
