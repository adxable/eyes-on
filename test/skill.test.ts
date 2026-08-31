import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { COMMANDS } from '../src/cli/commands.js';
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
  assert.ok(second.every((entry) => !entry.written), 'an unchanged skill is not rewritten');
  assert.ok(inspectSkill(root).every((entry) => entry.present && entry.current));
});
