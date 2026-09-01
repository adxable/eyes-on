import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitWithinCaps,
  instructionBytes,
  MAX_BYTES,
  MAX_ENTRIES,
  renderPathInstructions,
  type PathInstruction,
} from '../src/rules/export.js';
import { parseYaml } from '../src/core/yaml.js';

function entries(count: number, instructionLength = 60): PathInstruction[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `packages/pkg${index}/**`,
    instructions: 'x'.repeat(instructionLength),
  }));
}

test('the byte accounting is no-mistakes\' own formula, not an estimate of it', () => {
  // Mirrors ReviewPathInstructionsBytes in internal/config/config.go: the
  // leading blank line, the heading, and per entry its labels, its path, its
  // instructions, the 192-byte matched-file allowance and the separator.
  const one: PathInstruction[] = [{ path: 'a/**', instructions: 'do the thing' }];
  const heading =
    'Repository review instructions for the changed paths (trusted, from the default branch). Each block below applies only to the files listed under its path, and adds to the requirements above:';
  const expected =
    2 + heading.length + 1 + ('path: '.length + 'a/**'.length + 1) + ('matched files: '.length + 192 + 1) + ('instructions:'.length + 1) + 'do the thing'.length;
  assert.equal(instructionBytes(one), expected);
  assert.equal(instructionBytes([]), 0);
});

test('an export of any size stays inside both of no-mistakes\' caps', () => {
  // The caps are validated when no-mistakes parses the repository config,
  // before a run starts, so an over-budget export would hand somebody a file
  // that breaks their pipeline rather than degrading.
  for (const [count, length] of [
    [0, 0],
    [1, 10],
    [MAX_ENTRIES, 60],
    [200, 60],
    [10, 4000],
    [200, 4000],
  ] as [number, number][]) {
    const fitted = fitWithinCaps(entries(count, length));
    assert.ok(fitted.entries.length <= MAX_ENTRIES, `${count}x${length}: entry cap`);
    assert.ok(fitted.bytes <= MAX_BYTES, `${count}x${length}: byte cap (${fitted.bytes})`);
    assert.equal(fitted.entries.length + fitted.dropped.length, count, 'every candidate is accounted for');
  }
});

test('what falls off the end is reported rather than silently truncated', () => {
  const fitted = fitWithinCaps(entries(MAX_ENTRIES + 5));
  assert.equal(fitted.entries.length, MAX_ENTRIES);
  assert.equal(fitted.dropped.length, 5);
  assert.equal(fitted.reason, 'entry-cap');
  assert.deepEqual(
    fitted.dropped.map((entry) => entry.path),
    entries(MAX_ENTRIES + 5)
      .slice(MAX_ENTRIES)
      .map((entry) => entry.path),
    'the lowest-priority entries are the ones dropped',
  );
});

test('the byte cap bites before the entry cap when the instructions are long', () => {
  const fitted = fitWithinCaps(entries(MAX_ENTRIES, 3000));
  assert.equal(fitted.reason, 'byte-cap');
  assert.ok(fitted.entries.length < MAX_ENTRIES);
  assert.ok(fitted.dropped.length > 0);
});

test('priority order is preserved: a hard rule is never dropped for a history entry', () => {
  const hardRule: PathInstruction = { path: 'deploy/**', instructions: 'a hard rule' };
  const fitted = fitWithinCaps([hardRule, ...entries(MAX_ENTRIES + 10)]);
  assert.equal(fitted.entries[0]?.path, 'deploy/**');
  assert.ok(!fitted.dropped.some((entry) => entry.path === 'deploy/**'));
});

test('the rendered block is YAML that reads back as path_instructions', () => {
  const block = renderPathInstructions([
    { path: '**/*.ts', instructions: 'first line\nsecond line' },
    { path: 'deploy/**', instructions: 'single line' },
  ]);
  const parsed = parseYaml(block) as { review: { path_instructions: { path: string; instructions: string }[] } };
  assert.equal(parsed.review.path_instructions.length, 2);
  // The glob starts with `*`, which is not a valid bare YAML scalar: it has to
  // come back quoted or no repository would ever load the block.
  assert.equal(parsed.review.path_instructions[0]?.path, '**/*.ts');
  assert.equal(parsed.review.path_instructions[1]?.path, 'deploy/**');
});

test('an empty export is an explicit empty list rather than a truncated document', () => {
  const block = renderPathInstructions([]);
  const parsed = parseYaml(block) as { review: { path_instructions: unknown[] } };
  assert.deepEqual(parsed.review.path_instructions, []);
});
