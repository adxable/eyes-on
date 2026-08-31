import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoID } from '../src/core/repoid.js';

test('the id is 12 hex characters, deterministic, and separates distinct paths', () => {
  const id = repoID('/some/path');
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(id, repoID('/some/path'));
  assert.notEqual(id, repoID('/other/path'));
});

test('two spellings of one directory yield one id', () => {
  assert.equal(repoID('/some/path'), repoID('/some/./path/'));
});
