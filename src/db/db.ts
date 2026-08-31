import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { COLUMN_ADDITIONS, SCHEMA_STATEMENTS, SCHEMA_VERSION } from './schema.js';

/**
 * Thin data-access layer over `node:sqlite`.
 *
 * Two properties are load-bearing and both are copied from no-mistakes
 * (internal/db/db.go:26-71):
 *
 *   - WAL journaling, so a reader never blocks the daemon's writer;
 *   - exactly one connection per process. `DatabaseSync` is a single handle by
 *     construction, and every caller goes through open() rather than
 *     constructing its own, so the "one connection" rule is structural rather
 *     than a convention someone can forget.
 *
 * The layer stays thin on purpose (report R2): `node:sqlite` is still flagged
 * experimental in Node 22, and the fallback plan - better-sqlite3, or the
 * sqlite3 CLI - only stays cheap while the call surface is this narrow.
 */
export class Database {
  private readonly handle: DatabaseSync;
  readonly path: string;

  private constructor(handle: DatabaseSync, path: string) {
    this.handle = handle;
    this.path = path;
  }

  /** Opens (creating if needed) and migrates the database at path. */
  static open(path: string): Database {
    mkdirSync(dirname(path), { recursive: true });
    const handle = new DatabaseSync(path);
    handle.exec('PRAGMA journal_mode = WAL');
    handle.exec('PRAGMA synchronous = NORMAL');
    handle.exec('PRAGMA foreign_keys = ON');
    handle.exec('PRAGMA busy_timeout = 5000');
    const db = new Database(handle, path);
    db.migrate();
    return db;
  }

  /** Read-only handle. Used for the optional, never-required enrichment read of
   *  a foreign database (report K13: `?mode=ro`, nothing else). */
  static openReadOnly(path: string): Database {
    const handle = new DatabaseSync(path, { readOnly: true });
    return new Database(handle, path);
  }

  /**
   * Applies the declarative schema. Safe to run on every open: creates are
   * `IF NOT EXISTS` and column additions swallow the duplicate-column error,
   * which is what makes a second `eyes-on init` a repair instead of a failure.
   */
  migrate(): void {
    this.handle.exec('BEGIN');
    try {
      for (const statement of SCHEMA_STATEMENTS) {
        this.handle.exec(statement);
      }
      this.handle.exec('COMMIT');
    } catch (error) {
      this.handle.exec('ROLLBACK');
      throw error;
    }
    for (const addition of COLUMN_ADDITIONS) {
      this.addColumn(addition.table, addition.column, addition.definition);
    }
    this.handle
      .prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', SCHEMA_VERSION);
  }

  /** Adds a column, treating "already exists" as success. */
  addColumn(table: string, column: string, definition: string): void {
    try {
      this.handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (error) {
      const message = (error as Error).message ?? '';
      if (!/duplicate column name/i.test(message)) throw error;
    }
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  run(sql: string, ...params: SqlParam[]): void {
    this.handle.prepare(sql).run(...params);
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T[] {
    return this.handle.prepare(sql).all(...params) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.handle.prepare(sql).get(...params) as T | undefined;
  }

  /** Table names present, used by doctor to report a half-migrated database. */
  tables(): string[] {
    return this.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).map((row) => row.name);
  }

  close(): void {
    this.handle.close();
  }
}

export type SqlParam = string | number | bigint | null | Uint8Array;

export interface RepoRow {
  id: string;
  working_path: string;
  default_branch: string;
  created_at: number;
}

/** Registers or repairs a repository row. Keyed on working_path so a second
 *  `init` on the same clone updates the existing row instead of inserting a
 *  duplicate under a freshly computed id. */
export function upsertRepo(db: Database, repo: { id: string; workingPath: string; defaultBranch: string }): RepoRow {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO repos (id, working_path, default_branch, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(working_path) DO UPDATE SET default_branch = excluded.default_branch`,
    repo.id,
    repo.workingPath,
    repo.defaultBranch,
    now,
  );
  const row = db.get<RepoRow>('SELECT * FROM repos WHERE working_path = ?', repo.workingPath);
  if (!row) throw new Error(`repo row vanished after upsert: ${repo.workingPath}`);
  return row;
}

export function findRepoByPath(db: Database, workingPath: string): RepoRow | undefined {
  return db.get<RepoRow>('SELECT * FROM repos WHERE working_path = ?', workingPath);
}

export function listRepos(db: Database): RepoRow[] {
  return db.all<RepoRow>('SELECT * FROM repos ORDER BY created_at');
}
