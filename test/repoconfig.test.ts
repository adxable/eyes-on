import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FIX_PATTERN,
  defaultRepoConfig,
  parseRepoConfig,
  RepoConfigError,
} from '../src/risk/repoconfig.js';
import { fileFilter, isTestFile, testStem, directoryOf } from '../src/risk/files.js';

const APPENDIX_C3 = `
schema: eyes-on/v1
include: ["**/*.{ts,tsx,js,mjs}"]
exclude: ["**/node_modules/**", "**/*.generated.*"]
history_window_days: 90
fix_commit_pattern: "^(fix|hotfix)(\\\\(|:|!)"
weights:    { fix_history: 0.30, churn: 0.20, size: 0.20, spread: 0.10, no_test: 0.15, recency: 0.05, drift: 0.00 }
saturation: { fix_history: 5, churn: 20, size: 400, spread: 12, no_test: 1, recency: 30, drift: 5 }
thresholds: { read_fragments: 35, full_review: 65 }
hard_rules:
  - glob: "packages/provisioning/**"
    why:  "deployment configuration - a mistake costs a machine, not a test"
  - glob: "packages/channels/src/mailbox/**"
    why:  "the only path code takes out of the company"
model:
  agent: claude
  max_hunks: 12
`;

test('the Appendix C.3 document parses into exactly what it says', () => {
  const config = parseRepoConfig(APPENDIX_C3);
  assert.deepEqual(config.include, ['**/*.{ts,tsx,js,mjs}']);
  assert.deepEqual(config.exclude, ['**/node_modules/**', '**/*.generated.*']);
  assert.equal(config.history_window_days, 90);
  assert.equal(config.fix_commit_pattern, '^(fix|hotfix)(\\(|:|!)');
  assert.equal(config.weights.fix_history, 0.3);
  assert.equal(config.saturation.size, 400);
  assert.deepEqual(config.thresholds, { read_fragments: 35, full_review: 65 });
  assert.equal(config.hard_rules.length, 2);
  assert.equal(config.hard_rules[0]?.glob, 'packages/provisioning/**');
  assert.equal(config.model.agent, 'claude');
  assert.equal(config.model.max_hunks, 12);
});

test('the shipped fix pattern recognises the subjects it claims to', () => {
  const pattern = new RegExp(DEFAULT_FIX_PATTERN);
  for (const subject of ['fix: a thing', 'fix(scope): a thing', 'fix!: a thing', 'hotfix: a thing']) {
    assert.equal(pattern.test(subject), true, subject);
  }
  for (const subject of ['feat: a thing', 'fixture support', 'prefix: no']) {
    assert.equal(pattern.test(subject), false, subject);
  }
});

test('an empty document is the defaults, not an error', () => {
  assert.deepEqual(parseRepoConfig(''), defaultRepoConfig());
  assert.deepEqual(parseRepoConfig('# only a comment\n'), defaultRepoConfig());
});

test('a value that would change the outcome is refused rather than defaulted', () => {
  // Unlike the machine-policy config.yaml, which is repaired on the spot, a bad
  // value here would change which change reaches a human.
  const refused = [
    'schema: eyes-on/v2\n',
    'weights: { made_up: 0.5 }\n',
    'weights: { churn: -1 }\n',
    'thresholds: { read_fragments: 70, full_review: 65 }\n',
    'history_window_days: 0\n',
    'fix_commit_pattern: "^(unclosed"\n',
    'include: "not a list"\n',
    'include: ["a[bc"]\n',
    'hard_rules:\n  - why: "no glob here"\n',
    'hard_rules:\n  - glob: "a{b"\n    why: "unusable"\n',
  ];
  for (const source of refused) {
    assert.throws(() => parseRepoConfig(source), RepoConfigError, source);
  }
});

test('a refusal says what was wrong with the document', () => {
  try {
    parseRepoConfig('thresholds: { read_fragments: 70, full_review: 65 }\n');
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof RepoConfigError);
    assert.match(error.message, /read_fragments \(70\) must be below/);
  }
});

test('the default code filter keeps documentation and log-shaped data out', () => {
  // The measured requirement behind this: without it, AGENTS.md is the
  // riskiest file in the reference repository.
  const filter = fileFilter(defaultRepoConfig());
  for (const path of ['src/a.ts', 'cmd/main.go', 'lib/x.py', 'db/schema.sql', 'app/x.vue']) {
    assert.equal(filter.isCode(path), true, path);
  }
  for (const path of [
    'AGENTS.md',
    'docs/notes.md',
    'data/events.jsonl',
    'package-lock.json',
    'node_modules/x/index.js',
    'dist/bundle.js',
    'src/api.generated.ts',
    'web/app.min.js',
  ]) {
    assert.equal(filter.isCode(path), false, path);
  }
});

test('exclude wins over include', () => {
  const config = defaultRepoConfig();
  config.include = ['**/*.ts'];
  config.exclude = ['generated/**'];
  const filter = fileFilter(config);
  assert.equal(filter.isCode('src/a.ts'), true);
  assert.equal(filter.isCode('generated/a.ts'), false);
});

test('test files are recognised across the conventions the default include covers', () => {
  for (const path of [
    'src/a.test.ts',
    'src/a.spec.js',
    'pkg/a_test.go',
    'tests/test_a.py',
    'src/BarTest.java',
    'spec/a_spec.rb',
    'test/helpers.ts',
    'src/__tests__/a.ts',
  ]) {
    assert.equal(isTestFile(path), true, path);
  }
  for (const path of ['src/a.ts', 'src/latest.ts', 'src/contest.go']) {
    assert.equal(isTestFile(path), false, path);
  }
});

test('a test and the file it tests reduce to the same stem', () => {
  assert.equal(testStem('src/foo/bar.test.ts'), 'bar');
  assert.equal(testStem('src/foo/bar.ts'), 'bar');
  assert.equal(testStem('pkg/bar_test.go'), 'bar');
  assert.equal(testStem('tests/test_bar.py'), 'bar');
  assert.equal(testStem('src/BarTest.java'), 'bar');
});

test('directoryOf names the root as "." rather than as an empty string', () => {
  assert.equal(directoryOf('a/b/c.ts'), 'a/b');
  assert.equal(directoryOf('c.ts'), '.');
});
