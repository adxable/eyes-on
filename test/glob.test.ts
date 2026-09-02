import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glob, GlobError, matchesAny, matching, normalizePath } from '../src/core/glob.js';

test('the subset Appendix C.3 uses matches what it looks like it matches', () => {
  const cases: [string, string, boolean][] = [
    ['**/*.{ts,tsx,js,mjs}', 'packages/api/src/index.ts', true],
    ['**/*.{ts,tsx,js,mjs}', 'index.ts', true],
    ['**/*.{ts,tsx,js,mjs}', 'src/notes.md', false],
    ['packages/provisioning/**', 'packages/provisioning/src/scaleway.ts', true],
    ['packages/provisioning/**', 'packages/provisioning/README.md', true],
    ['packages/provisioning/**', 'packages/provisioner/src/a.ts', false],
    ['**/node_modules/**', 'a/b/node_modules/c/d.js', true],
    ['**/node_modules/**', 'node_modules/c/d.js', true],
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/nested/a.ts', false],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    ['**/*.[ch]', 'lib/x.c', true],
    ['**/*.[!ch]', 'lib/x.c', false],
  ];
  for (const [pattern, path, expected] of cases) {
    assert.equal(glob(pattern).matches(path), expected, `${pattern} against ${path}`);
  }
});

test('`**/` matches zero segments, so dir/** covers the directory itself', () => {
  assert.equal(glob('a/**/b.ts').matches('a/b.ts'), true);
  assert.equal(glob('a/**/b.ts').matches('a/x/y/b.ts'), true);
  assert.equal(glob('a/**').matches('a/b.ts'), true);
  assert.equal(glob('a/**').matches('a'), false);
});

test('a pattern with no separator matches by basename too', () => {
  assert.equal(glob('*.md').matches('docs/deep/notes.md'), true);
  assert.equal(glob('AGENTS.md').matches('sub/AGENTS.md'), true);
  // A pattern that names a directory is not treated this way: it would turn
  // every rule about a path into a rule about a filename.
  assert.equal(glob('docs/*.md').matches('other/docs/notes.md'), false);
});

test('a trailing slash means the directory contents', () => {
  assert.equal(glob('deploy/').matches('deploy/values.yaml'), true);
  assert.equal(glob('deploy/').matches('deployment.yaml'), false);
});

test('an unusable pattern is refused rather than silently matching nothing', () => {
  assert.throws(() => glob('a{b'), GlobError);
  assert.throws(() => glob('a[bc'), GlobError);
  assert.throws(() => glob('   '), GlobError);
});

test('matchesAny and matching skip an unusable pattern without failing the list', () => {
  assert.equal(matchesAny('src/a.ts', ['a{b', '**/*.ts']), true);
  assert.deepEqual(matching('src/a.ts', ['**/*.ts', '**/*.js', 'src/**']), ['**/*.ts', 'src/**']);
});

test('paths are normalised before matching', () => {
  assert.equal(normalizePath('./src/a.ts'), 'src/a.ts');
  assert.equal(glob('src/**').matches('./src/a.ts'), true);
});

test('a regular-expression metacharacter in a glob is a literal', () => {
  assert.equal(glob('src/a.ts').matches('src/axts'), false);
  assert.equal(glob('src/a+b.ts').matches('src/a+b.ts'), true);
});
