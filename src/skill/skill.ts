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

/**
 * The planned-command section, or nothing at all.
 *
 * With every command in the registry built there is no such section, and an
 * empty table under a heading promising one would tell an agent that eyes-on
 * has surfaces it is withholding. The section appears exactly when there is
 * something in it.
 */
function plannedSection(): string {
  const planned = plannedCommands();
  if (planned.length === 0) return '';
  const rows = planned.map((command) => `| \`${command.usage}\` | stage ${command.stage} | ${command.summary} |`);
  return `## Commands that are planned but not built yet

Calling one of these prints \`error:\` with the stage that owns it and exits 1. It never returns a made-up answer.

| Command | Stage | What it will do |
|---|---|---|
${rows.join('\n')}

`;
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

${plannedSection()}## The order these commands go in

\`\`\`sh
eyes-on check --intent "why this change was made, not what it changes"
eyes-on spotlight              # the three to five fragments to read
eyes-on comment --pr 42        # one sticky comment on the pull request
\`\`\`

\`check\` scores the change and, with an intent, measures how far the diff has drifted from it. \`spotlight\`
ranks fragments in two stages: arithmetic over the repository's history narrows the diff to twelve
candidates, and one model call picks three to five and says why. \`--no-model\` returns the first stage
alone and calls no model at all - use it when the model is rate-limited, and read the \`stage\` field to
see which answer you got.

## When a hard rule parks the run

A hard rule matching sets the band to \`pelna\` and parks the check as \`must_read\`. Answer it:

\`\`\`sh
eyes-on axi respond --action read
eyes-on axi respond --action waive --reason "why this is safe to merge unread"
\`\`\`

A waiver without a reason is refused. **The park holds nothing up outside eyes-on** - no exit code
changes, no push waits, no pull request goes red. What it does is record that somebody was told and what
they decided, so the channel label is evidence rather than a declaration.

## After the merge: the register

A merged change leaves one append-only line in the register, and that line is what makes the thresholds
arguable later rather than merely set:

\`\`\`sh
eyes-on label --pr 42          # after the merge; --dry-run reconstructs and writes nothing
eyes-on leaks --window 14d     # per channel: how often a merge was followed by a fix that blames it
eyes-on calibrate              # what each pair of thresholds would have caught, and let through
\`\`\`

\`label\` reconstructs the chain from the change to the commit that landed it using the \`(#N)\` subject a
squash merge leaves and GitHub's own answer, and records whether the two agree. It refuses to write a
line for a change eyes-on never assessed, because a register row inventing a channel would put that
change into the very comparison the register exists to make.

\`leaks\` reports the **line-level** variant only - a later fix whose blame names the merge commit. There
is no flag for the file-level one and asking for it is refused: its base rate is 45-73%, so every channel
scores nearly the same and no threshold can be argued from it. Below a hundred merges in a channel both
commands say in their header that the numbers are directional. Neither blocks anything.

## Output contract

- Machine-readable payload on **stdout**, TOON by default. Pass \`--format json\` for JSON or \`--format md\` for Markdown.
- Progress and diagnostics on **stderr**. Never parse stderr.
- Exit codes: \`0\` success or no-op, \`1\` error, \`2\` usage error.
- Every failure carries \`error:\` and \`help:\`. Read \`help:\` before retrying - it names the next step.

## Working with no-mistakes

Both tools read the same working clone and nothing else is shared. eyes-on never writes to
\`~/.no-mistakes\`, never creates a ref in your clone, and never touches a pull request body: the body is
no-mistakes' and is regenerated on every update, so eyes-on publishes a single comment carrying a marker
and updates that same comment however many times it is recomputed. It never merges and never files a
GitHub review.

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
