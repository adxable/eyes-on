import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseHunks, hunkSize, oldRange } from '../src/spot/hunks.js';
import { RepoReader } from '../src/git/reader.js';
import { tempDir, tempRepo } from './helpers.js';

/**
 * The diff parser, which is the input to every fragment the product will ever
 * point at. A fragment naming the wrong file or the wrong line is worse than no
 * fragment, so these tests are mostly about the awkward shapes: a creation, a
 * deletion, a path git quotes, and a diff of several files at once.
 */

function readerFor(path: string): RepoReader {
  return new RepoReader({ clonePath: path, mirrorPath: join(tempDir('hunks-mirror'), 'absent.git') });
}

test('a hunk knows its file, both ranges and the first line that changed', () => {
  const hunks = parseHunks(
    [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,6 +10,7 @@ function thing() {',
      ' const untouched = 1;',
      ' const alsoUntouched = 2;',
      '-const wrong = 3;',
      '+const right = 3;',
      '+const extra = 4;',
      ' const after = 5;',
      '',
    ].join('\n'),
  );
  assert.equal(hunks.length, 1);
  const hunk = hunks[0];
  assert.ok(hunk);
  assert.equal(hunk.path, 'src/a.ts');
  assert.equal(hunk.oldStart, 10);
  assert.equal(hunk.oldCount, 6);
  assert.equal(hunk.newStart, 10);
  assert.equal(hunk.newCount, 7);
  assert.equal(hunk.added, 2);
  assert.equal(hunk.removed, 1);
  assert.equal(hunkSize(hunk), 3);
  // Two context lines precede the change, so the reader is sent to line 12.
  assert.equal(hunk.anchor, 12);
  assert.deepEqual(oldRange(hunk), { start: 10, end: 15 });
  assert.match(hunk.text, /^@@ -10,6 \+10,7 @@/);
  assert.match(hunk.text, /\+const extra = 4;/);
});

test('a created file has no old side to blame and a deleted file is reported in old coordinates', () => {
  const hunks = parseHunks(
    [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+export const a = 1;',
      '+export const b = 2;',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-export const c = 1;',
      '-export const d = 2;',
      '-export const e = 3;',
      '',
    ].join('\n'),
  );
  assert.equal(hunks.length, 2);
  const [created, deleted] = hunks;
  assert.ok(created && deleted);

  assert.equal(created.path, 'new.ts');
  assert.equal(created.created, true);
  assert.equal(created.deleted, false);
  assert.equal(created.anchor, 1);
  assert.equal(oldRange(created), null, 'a creation has nothing on the old side to blame');

  assert.equal(deleted.path, 'gone.ts');
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.anchor, 1, 'a deleted file is pointed at in the coordinates its content still has');
  assert.deepEqual(oldRange(deleted), { start: 1, end: 3 });
});

test('a path git C-quotes parses back to the name it actually has', () => {
  // Anything outside printable ASCII is quoted by git unless core.quotePath is
  // off. Left as written, such a path matches no glob and blames nothing.
  const hunks = parseHunks(
    [
      'diff --git "a/deploy/warto\\305\\233ci.yaml" "b/deploy/warto\\305\\233ci.yaml"',
      '--- "a/deploy/warto\\305\\233ci.yaml"',
      '+++ "b/deploy/warto\\305\\233ci.yaml"',
      '@@ -1 +1 @@',
      '-replicas: 3',
      '+replicas: 4',
      '',
    ].join('\n'),
  );
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]?.path, 'deploy/wartości.yaml');
});

test('a binary file contributes no hunk rather than a hunk with no lines', () => {
  const hunks = parseHunks(
    [
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ',
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-const a = 1;',
      '+const a = 2;',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    hunks.map((hunk) => hunk.path),
    ['src/a.ts'],
  );
});

test('an empty diff parses to nothing rather than failing', () => {
  assert.deepEqual(parseHunks(''), []);
  assert.deepEqual(parseHunks('\n\n'), []);
});

test('a real git diff of a real repository parses into the fragments it shows', () => {
  const repo = tempRepo('hunks');
  const base = repo.commitFiles('feat: two files', {
    'src/a.ts': `${Array.from({ length: 20 }, (_, index) => `const a${index} = ${index};`).join('\n')}\n`,
    'src/b.ts': 'export const b = 1;\n',
  });
  const head = repo.commitFiles('feat: change both', {
    'src/a.ts': `${Array.from({ length: 20 }, (_, index) => `const a${index} = ${index === 5 ? 99 : index};`).join('\n')}\n`,
    'src/b.ts': 'export const b = 2;\nexport const c = 3;\n',
  });

  const hunks = parseHunks(readerFor(repo.path).rangePatch(base, head));
  const paths = [...new Set(hunks.map((hunk) => hunk.path))].sort();
  assert.deepEqual(paths, ['src/a.ts', 'src/b.ts']);
  const inA = hunks.find((hunk) => hunk.path === 'src/a.ts');
  assert.ok(inA);
  // Line 6 is the one that changed; with three lines of context the hunk starts
  // at 3 and the anchor is still the changed line.
  assert.equal(inA.anchor, 6);
  assert.ok(inA.added >= 1 && inA.removed >= 1);
});
