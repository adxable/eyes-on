/**
 * Schema for the eyes-on state database (report Appendix C.2).
 *
 * Migrations are idempotent by construction: every statement is either
 * `CREATE ... IF NOT EXISTS` or an `ALTER TABLE ADD COLUMN` executed through
 * addColumn(), which tolerates the column already existing. That is the same
 * discipline no-mistakes runs (internal/db/schema.go) and it is what makes
 * `eyes-on init` safe to run twice: the second run repairs, it does not
 * duplicate.
 *
 * Tables beyond `repos` and `checks` are created empty at stage 0. They are
 * here rather than in a later migration because the layout is already decided
 * (Appendix C.2) and creating them now means stage 1 adds rows, not tables.
 */

export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS repos (
     id             TEXT PRIMARY KEY,
     working_path   TEXT NOT NULL UNIQUE,
     default_branch TEXT NOT NULL DEFAULT '',
     created_at     INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS checks (
     id                 TEXT PRIMARY KEY,
     repo_id            TEXT NOT NULL,
     branch             TEXT NOT NULL DEFAULT '',
     base_sha           TEXT NOT NULL DEFAULT '',
     head_sha           TEXT NOT NULL DEFAULT '',
     score              INTEGER,
     band               TEXT,
     drift              INTEGER,
     intent             TEXT,
     intent_source      TEXT,
     status             TEXT NOT NULL DEFAULT 'running',
     trusted_config_sha TEXT,
     created_at         INTEGER NOT NULL,
     updated_at         INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS checks_repo_head ON checks (repo_id, head_sha)`,
  `CREATE INDEX IF NOT EXISTS checks_repo_branch ON checks (repo_id, branch, created_at)`,
  `CREATE TABLE IF NOT EXISTS signals (
     check_id   TEXT NOT NULL,
     name       TEXT NOT NULL,
     raw        REAL,
     normalized REAL,
     PRIMARY KEY (check_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS hits (
     check_id TEXT NOT NULL,
     glob     TEXT NOT NULL,
     file     TEXT NOT NULL,
     why      TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS hits_check ON hits (check_id)`,
  `CREATE TABLE IF NOT EXISTS spots (
     check_id TEXT NOT NULL,
     file     TEXT NOT NULL,
     line     INTEGER,
     category TEXT,
     why      TEXT,
     weight   REAL
   )`,
  `CREATE INDEX IF NOT EXISTS spots_check ON spots (check_id)`,
  `CREATE TABLE IF NOT EXISTS decisions (
     check_id   TEXT NOT NULL,
     action     TEXT NOT NULL,
     reason     TEXT,
     decided_by TEXT,
     decided_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS decisions_check ON decisions (check_id)`,
  // One row per item rather than a joined string, for the same reason
  // `hard_rule_matches` is a list: a sentence containing the separator read
  // back out of a joined cell becomes two sentences nobody wrote.
  `CREATE TABLE IF NOT EXISTS drift_items (
     check_id TEXT NOT NULL,
     kind     TEXT NOT NULL,
     position INTEGER NOT NULL,
     item     TEXT NOT NULL,
     PRIMARY KEY (check_id, kind, position)
   )`,
  `CREATE INDEX IF NOT EXISTS drift_items_check ON drift_items (check_id)`,
  `CREATE TABLE IF NOT EXISTS prs (
     repo_id      TEXT NOT NULL,
     number       INTEGER NOT NULL,
     url          TEXT,
     head_sha     TEXT,
     state        TEXT,
     merge_sha    TEXT,
     commented_at INTEGER,
     observed_at  INTEGER,
     PRIMARY KEY (repo_id, number)
   )`,
  `CREATE TABLE IF NOT EXISTS blame_cache (
     commit_sha TEXT PRIMARY KEY,
     payload    TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS schema_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

/** Columns added after a table shipped. Empty at stage 0; the mechanism is
 *  exercised by tests so the first real migration is not the first time it
 *  runs. */
export interface ColumnAddition {
  table: string;
  column: string;
  definition: string;
}

export const COLUMN_ADDITIONS: readonly ColumnAddition[] = [
  // Stage 2. `spots` shipped at stage 0 without a column saying which stage
  // chose a fragment, and the distinction is the product: a fragment the
  // arithmetic picked carries no category, and a reader must be able to tell
  // that from one the model categorised.
  { table: 'spots', column: 'source', definition: "TEXT NOT NULL DEFAULT 'rank'" },
  // Stage 2. The weights sum to 1.20 once drift is scored, so a score is only
  // meaningful beside the maximum it was computed under. Recomputing that
  // denominator when the row is read would let it disagree with the number it
  // describes, so it is stored with the score. A row written before this column
  // existed has no value, and a reader must say so rather than assume 100.
  { table: 'checks', column: 'score_max', definition: 'INTEGER' },
];

/** Schema version recorded in schema_meta, for diagnostics only: the
 *  migrations themselves are declarative and do not branch on it. */
export const SCHEMA_VERSION = '2';
