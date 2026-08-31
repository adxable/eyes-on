import { COMMANDS, implementedCommands, plannedCommands } from '../cli/commands.js';
import { PRODUCT_NAME } from '../core/version.js';

/**
 * The `/eyes-on` skill, rendered from the same command table the CLI
 * dispatches on (report M20).
 *
 * Generating it is half the point; the other half is test/skill.test.ts, which
 * fails when the checked-in SKILL.md drifts from this rendering and when a
 * command exists in the registry but not in the skill. An agent-facing
 * instruction nobody tests is an instruction that is wrong by next week.
 */

export const SKILL_NAME = PRODUCT_NAME;

export const SKILL_DESCRIPTION =
  'Find out what a human actually has to read in a change before it is merged - risk computed from repository history, hard rules on sensitive paths, and the specific fragments a reviewer should actually look at. Use when preparing a change for review, deciding whether a change needs human eyes, or when the user invokes /eyes-on.';

function commandTable(): string {
  const lines: string[] = [];
  for (const command of implementedCommands()) {
    lines.push(`| \`${command.usage}\` | ${command.summary} |`);
  }
  return lines.join('\n');
}

function plannedTable(): string {
  const lines: string[] = [];
  for (const command of plannedCommands()) {
    lines.push(`| \`${command.usage}\` | stage ${command.stage} | ${command.summary} |`);
  }
  return lines.join('\n');
}

export function skillMarkdown(): string {
  return `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
user-invocable: true
---

# eyes-on

eyes-on answers one question: **does a human need to read this change, and if so, which parts?**

It computes risk from the repository's own history, applies hard rules to sensitive paths, records the
decision as a durable record, and after the merge checks whether the decision was right.

## What eyes-on is not

It does not review code, fix code, commit, push, open or merge pull requests, edit a pull request body,
run tests or lint, or block anything. Those belong to no-mistakes and to CI. eyes-on runs beside them and
writes nothing into their state. If you want your change validated and shipped, that is \`/no-mistakes\`;
this skill tells you what a reviewer must look at.

## Commands available now

| Command | What it does |
|---|---|
${commandTable()}

## Commands that are planned but not built yet

Calling one of these prints \`error:\` with the stage that owns it and exits 1. It never returns a made-up answer.

| Command | Stage | What it will do |
|---|---|---|
${plannedTable()}

## Output contract

- Machine-readable payload on **stdout**, TOON by default. Pass \`--format json\` for JSON or \`--format md\` for Markdown.
- Progress and diagnostics on **stderr**. Never parse stderr.
- Exit codes: \`0\` success or no-op, \`1\` error, \`2\` usage error.
- Every failure carries \`error:\` and \`help:\`. Read \`help:\` before retrying - it names the next step.

## Working with no-mistakes

Both tools read the same working clone and nothing else is shared. eyes-on never writes to
\`~/.no-mistakes\`, never creates a ref in your clone, and never touches a pull request body.

Called from inside a no-mistakes pipeline step - \`NO_MISTAKES_GATE=1\`, or a working directory under the
no-mistakes worktree root - eyes-on refuses to record anything and says so. That is deliberate: the work
a pipeline step is holding is still being rewritten, so an assessment of it would be an assessment of
nothing. Read-only commands keep working there.

The useful order is: assess with eyes-on first, then run \`/no-mistakes\` to validate and ship.

## Getting started in a repository

\`\`\`sh
eyes-on init          # register the repository, build the mirror, start the daemon
eyes-on doctor        # what is available and what is degraded
eyes-on status        # daemon and registered repositories
\`\`\`

\`eyes-on init\` is idempotent: run it again to repair a missing mirror, a stopped daemon or a stale skill.
`;
}

/** Command names the skill is expected to mention, for the drift test. */
export function skillCommandNames(): string[] {
  return COMMANDS.map((command) => command.name);
}
