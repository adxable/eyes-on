import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, stringifyYaml, YamlError } from '../src/core/yaml.js';

test('block mappings, nesting, comments and typed scalars parse', () => {
  const parsed = parseYaml(`
# a comment
schema: eyes-on/v1
daemon:
  managed_service: true
logs:
  max_bytes: 8388608
  backups: 2
note: "a value: with a colon"
missing: null
`);
  assert.deepEqual(parsed, {
    schema: 'eyes-on/v1',
    daemon: { managed_service: true },
    logs: { max_bytes: 8388608, backups: 2 },
    note: 'a value: with a colon',
    missing: null,
  });
});

test('the repository config shape from Appendix C.3 parses', () => {
  const parsed = parseYaml(`
schema: eyes-on/v1
include: ["**/*.ts", "**/*.tsx"]
history_window_days: 90
weights: { fix_history: 0.30, churn: 0.20 }
thresholds: { read_fragments: 35, full_review: 65 }
hard_rules:
  - glob: "packages/provisioning/**"
    why: "deployment configuration"
  - glob: "packages/channels/**"
    why: "the only path out of the company"
`) as Record<string, unknown>;
  assert.deepEqual(parsed.include, ['**/*.ts', '**/*.tsx']);
  assert.deepEqual(parsed.weights, { fix_history: 0.3, churn: 0.2 });
  assert.deepEqual(parsed.hard_rules, [
    { glob: 'packages/provisioning/**', why: 'deployment configuration' },
    { glob: 'packages/channels/**', why: 'the only path out of the company' },
  ]);
});

test('malformed input fails loudly rather than parsing to something wrong', () => {
  assert.throws(() => parseYaml('key without a colon\n'), YamlError);
  assert.throws(() => parseYaml('a: { b: 1\n'), YamlError);
});

test('what stringify writes, parse reads back', () => {
  const value = {
    schema: 'eyes-on/v1',
    daemon: { managed_service: true },
    logs: { max_bytes: 8388608, backups: 2 },
    telemetry: { enabled: false },
  };
  assert.deepEqual(parseYaml(stringifyYaml(value)), value);
});

test('literal block scalars parse, in both chomping modes the subset accepts', () => {
  const parsed = parseYaml(`
review:
  path_instructions:
    - path: "deploy/**"
      instructions: |
        Read this in full.
        A # here is text, not a comment.
    - path: "src/**"
      instructions: |-
        One line, no trailing newline.
`) as { review: { path_instructions: { path: string; instructions: string }[] } };
  const entries = parsed.review.path_instructions;
  assert.equal(entries[0]?.instructions, 'Read this in full.\nA # here is text, not a comment.\n');
  assert.equal(entries[1]?.instructions, 'One line, no trailing newline.');
});

test('a block scalar style outside the subset is refused rather than half-read', () => {
  assert.throws(() => parseYaml('why: >\n  folded text\n'), YamlError);
  assert.throws(() => parseYaml('why: |+\n  kept text\n'), YamlError);
});

test('a sequence item keeps its own nesting rather than flattening it', () => {
  const parsed = parseYaml(`
rules:
  - glob: "a/**"
    model:
      command: ["claude", "-p"]
      max_hunks: 12
  - glob: "b/**"
`) as { rules: { glob: string; model?: { command: string[]; max_hunks: number } }[] };
  assert.deepEqual(parsed.rules[0]?.model, { command: ['claude', '-p'], max_hunks: 12 });
  assert.equal(parsed.rules[1]?.glob, 'b/**');
});

test('a block scalar keeps a body line that begins with #, because there it is content', () => {
  // A comment-only line used to be dropped by the scanner before the block
  // scalar could read it, so the value silently lost a line. A document that
  // parses to the wrong thing is worse than one that fails.
  const parsed = parseYaml(`
hard_rules:
  - glob: "deploy/**"
    why: |
      first
      # second
      third
instructions: |-
  # a leading hash
  and a second line
`) as { hard_rules: { why: string }[]; instructions: string };
  assert.equal(parsed.hard_rules[0]?.why, 'first\n# second\nthird\n');
  assert.equal(parsed.instructions, '# a leading hash\nand a second line');
});

test('a comment between structural lines is still invisible, wherever it sits', () => {
  const parsed = parseYaml(`
  # an indented comment before anything
schema: eyes-on/v1
logs:
# a comment less indented than the mapping it interrupts
  max_bytes: 8388608
  # and one more indented
  backups: 2
rules:
  - glob: "a/**"
  # between two sequence items
  - glob: "b/**"
`) as Record<string, unknown>;
  assert.deepEqual(parsed, {
    schema: 'eyes-on/v1',
    logs: { max_bytes: 8388608, backups: 2 },
    rules: [{ glob: 'a/**' }, { glob: 'b/**' }],
  });
});

test('a document of nothing but comments is empty rather than a parse error', () => {
  assert.deepEqual(parseYaml('# only\n# comments\n'), {});
});
