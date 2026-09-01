import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tempDir, tempRepo } from './helpers.js';
import { RepoReader, parseRemovedRanges } from '../src/git/reader.js';
import { attributeFixes, blameFix, fixCountsByFile, isFixCommit } from '../src/risk/szz.js';
import { Database } from '../src/db/db.js';
import { DEFAULT_FIX_PATTERN } from '../src/risk/repoconfig.js';

const FIX_PATTERN = new RegExp(DEFAULT_FIX_PATTERN);

function readerFor(clonePath: string): RepoReader {
  // No mirror: the reader falls back to the clone through the allow-list, which
  // is the path a repository eyes-on has never registered takes.
  return new RepoReader({ clonePath, mirrorPath: join(tempDir('mirror'), 'absent.git') });
}

test('a fix commit is recognised by subject, and a revert by its own shape', () => {
  const commit = (subject: string) => ({ sha: 'a'.repeat(40), timestamp: 0, subject, parents: [], files: [] });
  assert.equal(isFixCommit(commit('fix: the thing'), FIX_PATTERN), true);
  assert.equal(isFixCommit(commit('hotfix(api): the thing'), FIX_PATTERN), true);
  assert.equal(isFixCommit(commit('Revert "feat: the thing"'), FIX_PATTERN), true);
  assert.equal(isFixCommit(commit('feat: the thing'), FIX_PATTERN), false);
  assert.equal(isFixCommit(commit('fixture support'), FIX_PATTERN), false);
});

test('only hunks that removed content are collected, in the parent\'s coordinates', () => {
  const patch = [
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,3 +10,2 @@',
    '-old one',
    '-old two',
    '-old three',
    '+new',
    '@@ -40,0 +39,2 @@',
    '+added only',
    '+added again',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,3 @@',
    '+brand new',
  ].join('\n');
  assert.deepEqual(parseRemovedRanges(patch), [{ path: 'src/a.ts', start: 10, end: 12 }]);
});

test('a fix blames into the file whose lines it removed, and into no other', () => {
  const repo = tempRepo('szz');
  repo.commitFiles('feat: introduce the bug', {
    'src/hot.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
    'src/quiet.ts': 'export const quiet = true;\n',
  });
  repo.commitFiles('fix: correct the bug', {
    'src/hot.ts': 'const a = 1;\nconst b = 22;\nconst c = 3;\n',
  });

  const reader = readerFor(repo.path);
  const commits = reader.history({ until: 'HEAD' });
  const result = attributeFixes(commits, { reader, db: null, fixPattern: FIX_PATTERN });

  assert.equal(result.attributions.length, 1, 'one fix commit');
  const counts = fixCountsByFile(result.attributions);
  assert.equal(counts.get('src/hot.ts'), 1);
  assert.equal(counts.get('src/quiet.ts'), undefined, 'a file the fix never touched is not blamed');
});

test('a fix is one piece of evidence about a file however many lines it rewrote', () => {
  const repo = tempRepo('szz-lines');
  const twenty = Array.from({ length: 20 }, (_, index) => `const v${index} = ${index};`).join('\n');
  repo.commitFiles('feat: twenty lines', { 'src/wide.ts': twenty });
  repo.commitFiles('fix: rewrite all twenty', {
    'src/wide.ts': Array.from({ length: 20 }, (_, index) => `const v${index} = ${index + 1};`).join('\n'),
  });

  const reader = readerFor(repo.path);
  const result = attributeFixes(reader.history({ until: 'HEAD' }), {
    reader,
    db: null,
    fixPattern: FIX_PATTERN,
  });
  // Twenty blamed lines, but one fix: counting lines would let a single
  // reformatting-shaped fix saturate the signal (K = 5) on its own.
  assert.equal(result.attributions[0]?.files['src/wide.ts'], 20);
  assert.equal(fixCountsByFile(result.attributions).get('src/wide.ts'), 1);
});

test('a pure addition points at nothing and is not counted as a fix touch', () => {
  const repo = tempRepo('szz-add');
  repo.commitFiles('feat: a file', { 'src/a.ts': 'one\n' });
  repo.commitFiles('fix: add a guard, removing nothing', { 'src/a.ts': 'one\ntwo\n' });

  const reader = readerFor(repo.path);
  const result = attributeFixes(reader.history({ until: 'HEAD' }), {
    reader,
    db: null,
    fixPattern: FIX_PATTERN,
  });
  assert.equal(result.attributions.length, 1, 'the commit is still recognised as a fix');
  assert.deepEqual(result.attributions[0]?.files, {}, 'but it blames nothing');
  assert.equal(fixCountsByFile(result.attributions).size, 0);
});

test('the cache answers with what the computation would have produced', () => {
  const repo = tempRepo('szz-cache');
  repo.commitFiles('feat: a bug', { 'src/a.ts': 'one\ntwo\nthree\n' });
  repo.commitFiles('fix: the bug', { 'src/a.ts': 'one\nTWO\nthree\n' });

  const reader = readerFor(repo.path);
  const db = Database.open(join(tempDir('db'), 'state.sqlite'));
  const commits = reader.history({ until: 'HEAD' });

  const first = attributeFixes(commits, { reader, db, fixPattern: FIX_PATTERN });
  assert.equal(first.computed, 1);
  assert.equal(first.cached, 0);

  const second = attributeFixes(commits, { reader, db, fixPattern: FIX_PATTERN });
  assert.equal(second.computed, 0, 'the second run computes nothing');
  assert.equal(second.cached, 1);
  assert.deepEqual(second.attributions, first.attributions, 'and answers identically');

  const fix = commits.find((commit) => isFixCommit(commit, FIX_PATTERN));
  assert.ok(fix);
  const direct = blameFix(reader, fix);
  assert.deepEqual(second.attributions[0]?.files, direct.files, 'the cache is not a different answer');
  db.close();
});

test('a root commit has no parent to blame and contributes nothing', () => {
  const repo = tempRepo('szz-root');
  // The seed commit is the root; renaming it into a fix leaves nothing behind
  // it to attribute.
  repo.git(['commit', '-q', '--amend', '-m', 'fix: the very first commit']);
  const reader = readerFor(repo.path);
  const result = attributeFixes(reader.history({ until: 'HEAD' }), {
    reader,
    db: null,
    fixPattern: FIX_PATTERN,
  });
  assert.equal(result.attributions.length, 1);
  assert.deepEqual(result.attributions[0]?.files, {});
});

test('merge commits are excluded from the history walk, so their lines are not counted twice', () => {
  const repo = tempRepo('szz-merge');
  repo.commitFiles('feat: base', { 'src/a.ts': 'base\n' });
  repo.branch('side');
  repo.checkout('side');
  repo.commitFiles('feat: on the side', { 'src/b.ts': 'side\n' });
  repo.checkout('main');
  repo.commitFiles('feat: on main', { 'src/c.ts': 'main\n' });
  repo.git(['merge', '--no-ff', '-q', '-m', 'Merge branch side', 'side']);

  const reader = readerFor(repo.path);
  const commits = reader.history({ until: 'HEAD' });
  assert.equal(
    commits.some((commit) => commit.parents.length > 1),
    false,
    'no merge commit reaches the history walk',
  );
});
