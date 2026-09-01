import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './db.js';
import type { Assessment } from '../risk/assess.js';
import type { Paths } from '../core/paths.js';

/**
 * Recording an assessment (report Appendix C.2).
 *
 * A check is identified by the repository, the two commits it spans and the
 * intent it was given, so re-running `check` on an unchanged head updates one
 * row instead of accumulating a row per invocation. The id is derived rather
 * than random for the same reason: stage 2's gate and stage 3's ledger both
 * have to find the assessment of a given head again, and a random id would
 * make that a lookup by timestamp - which is the kind of thing that works until
 * two runs land in the same second.
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
}

/**
 * Writes the check, its signals and its rule hits.
 *
 * `status` distinguishes the three outcomes a caller has to tell apart:
 * `done` for a complete assessment, `unverified` when the trusted config could
 * not be read (so the hard rules were never evaluated), and - from stage 2 -
 * `must_read` for a parked run. Stage 1 never writes `must_read`: a hard-rule
 * hit sets the band, and the gate that parks on it is stage 2's.
 */
export function recordCheck(db: Database, options: RecordOptions): string {
  const { assessment } = options;
  const id = checkID(options.repoId, assessment.base_sha, assessment.head_sha);
  const now = Math.floor(Date.now() / 1000);
  const status = assessment.config_state === 'unverified' ? 'unverified' : 'done';

  db.run(
    `INSERT INTO checks (id, repo_id, branch, base_sha, head_sha, score, band, drift, intent, intent_source,
                         status, trusted_config_sha, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       branch = excluded.branch,
       score = excluded.score,
       band = excluded.band,
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
    assessment.band,
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
