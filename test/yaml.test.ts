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
