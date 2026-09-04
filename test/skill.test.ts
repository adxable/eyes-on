import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { COMMANDS, implementedCommands } from '../src/cli/commands.js';
import { skillMarkdown, SKILL_NAME } from '../src/skill/skill.js';
import { installSkill, inspectSkill, INSTALL_BASES } from '../src/skill/install.js';
import { tempDir } from './helpers.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The drift test the report asks for (M20). An agent-facing instruction that is
 * maintained by hand disagrees with the CLI within a week, so the checked-in
 * skill is generated and this test is what keeps it generated.
 */
test('the checked-in skill matches what the code renders', () => {
  const onDisk = readFileSync(join(packageRoot, 'skills', SKILL_NAME, 'SKILL.md'), 'utf8');
  assert.equal(onDisk, skillMarkdown(), 'run `npm run genskill` to regenerate skills/eyes-on/SKILL.md');
});

test('every command in the registry appears in the skill with its live usage string', () => {
  const markdown = skillMarkdown();
  for (const command of COMMANDS) {
    assert.ok(
      markdown.includes(command.usage),
      `the skill does not document \`${command.usage}\` - it would tell an agent the wrong invocation`,
    );
  }
});

/**
 * The README's "Available now" table is the human copy of `COMMANDS` - the same
 * surface the dispatcher, `help` and the generated skill come from. It is
 * maintained by hand, because its right-hand column is prose written for a
 * reader rather than the registry's summaries, so this test is what keeps the
 * left-hand column from drifting: three review rounds found a flag documented
 * in the registry and the skill but missing from README. The table is parsed
 * into the set of invocations it claims exist, and that set is compared with
 * the registry - no substring stands in for the comparison.
 */
function readmeCommandTable(): string[] {
  const readme = readFileSync(join(packageRoot, 'README.md'), 'utf8').split('\n');
  const header = readme.indexOf('| Command | What it does |');
  assert.ok(header >= 0, 'README no longer has a command table to compare with the registry');
  const rows: string[] = [];
  for (const line of readme.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    // Cells are split on unescaped pipes: `daemon` and `axi` carry `\|` inside
    // their own braces, and splitting on those would cut one invocation in two.
    const first = line.replace(/^\|/, '').split(/(?<!\\)\|/)[0] ?? '';
    rows.push(first.replaceAll('\\|', '|').replaceAll('`', '').trim());
  }
  return rows;
}

test('the README command table claims exactly the invocations the registry defines', () => {
  assert.deepEqual(
    readmeCommandTable().sort(),
    implementedCommands().map((command) => command.usage).sort(),
    'README.md and src/cli/commands.ts disagree about the command surface',
  );
});

test('the skill states the output contract the CLI actually implements', () => {
  const markdown = skillMarkdown();
  for (const claim of ['stdout', 'stderr', '`0` success', '`1` error', '`2` usage error', 'error:', 'help:']) {
    assert.ok(markdown.includes(claim), `the skill omits the contract detail ${claim}`);
  }
});

test('the skill states the boundary with no-mistakes rather than implying overlap', () => {
  const markdown = skillMarkdown();
  assert.ok(markdown.includes('does not review code'));
  assert.ok(markdown.includes('NO_MISTAKES_GATE=1'));
  assert.ok(markdown.includes('~/.no-mistakes'));
});

test('unimplemented commands are declared as such, so no agent expects an answer', () => {
  const markdown = skillMarkdown();
  assert.ok(markdown.includes('planned but not built yet'));
  for (const command of COMMANDS.filter((entry) => !entry.implemented)) {
    assert.ok(markdown.includes(`| stage ${command.stage} |`), `stage missing for ${command.name}`);
  }
});

test('install writes both skill bases and rewrites only when stale', () => {
  const root = tempDir('skill-root');
  const first = installSkill(root);
  assert.equal(first.length, INSTALL_BASES.length);
  assert.ok(first.every((entry) => entry.written));
  for (const entry of first) {
    assert.equal(readFileSync(entry.path, 'utf8'), skillMarkdown());
  }

  const second = installSkill(root);
  assert.equal(second.length, INSTALL_BASES.length);
  assert.ok(second.every((entry) => !entry.written), 'an unchanged skill is not rewritten');
  const inspected = inspectSkill(root);
  assert.equal(inspected.length, INSTALL_BASES.length);
  assert.ok(inspected.every((entry) => entry.present && entry.current));
});
