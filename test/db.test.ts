import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Database, findRepoByPath, listRepos, upsertRepo } from '../src/db/db.js';
import { tempDir } from './helpers.js';

test('the database opens with WAL and a full schema', () => {
  const db = Database.open(join(tempDir('db'), 'state.sqlite'));
  const mode = db.get<{ journal_mode: string }>('PRAGMA journal_mode');
  assert.equal(mode?.journal_mode, 'wal');
  const tables = db.tables();
  for (const expected of ['repos', 'checks', 'signals', 'hits', 'spots', 'decisions', 'prs', 'blame_cache']) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
  db.close();
});

test('migrations are idempotent: re-opening changes nothing and loses nothing', () => {
  const path = join(tempDir('db'), 'state.sqlite');
  const first = Database.open(path);
  upsertRepo(first, { id: 'aaaaaaaaaaaa', workingPath: '/repo/one', defaultBranch: 'main' });
  const tablesBefore = first.tables();
  first.close();

  const second = Database.open(path);
  second.migrate();
  second.migrate();
  assert.deepEqual(second.tables(), tablesBefore);
  assert.equal(listRepos(second).length, 1);
  second.close();
});

test('a second registration of the same clone updates rather than duplicates', () => {
  const db = Database.open(join(tempDir('db'), 'state.sqlite'));
  upsertRepo(db, { id: 'aaaaaaaaaaaa', workingPath: '/repo/one', defaultBranch: 'main' });
  upsertRepo(db, { id: 'aaaaaaaaaaaa', workingPath: '/repo/one', defaultBranch: 'trunk' });
  assert.equal(listRepos(db).length, 1);
  assert.equal(findRepoByPath(db, '/repo/one')?.default_branch, 'trunk');
  db.close();
});

test('adding a column that already exists is a no-op, so a re-run repairs', () => {
  const db = Database.open(join(tempDir('db'), 'state.sqlite'));
  db.addColumn('repos', 'extra_note', 'TEXT');
  db.addColumn('repos', 'extra_note', 'TEXT');
  const columns = db.all<{ name: string }>('PRAGMA table_info(repos)').map((row) => row.name);
  assert.equal(columns.filter((name) => name === 'extra_note').length, 1);
  db.close();
});
