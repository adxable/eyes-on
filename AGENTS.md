# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## What this product is, and what it must never do

eyes-on decides **what a human has to read** in a change before it is merged. It
runs beside no-mistakes and is not a fork, a plugin or a competitor.

The prohibitions below are the product, not defensive coding. Breaking one is a
correctness bug even when everything still passes:

- never write anything under `~/.no-mistakes/**`, and never install a hook in the
  no-mistakes gate or use its `pre-receive.no-mistakes-user` slot. Every eyes-on
  write lives under the state root, so this is enforced where the root is
  resolved: `Paths` refuses a root inside `NM_HOME` (physical-path containment,
  any depth) and no command gets far enough to create it;
- never write a ref, an index entry, a remote or a config value into a working
  clone. `git()` in `src/git/git.ts` is module-private, so a clone is reachable
  only through `gitReadClone()`, which refuses any subcommand outside the
  allow-list and refuses the write forms of the three that can go either way
  (`config`, `remote`, `symbolic-ref`), or through `fetchCloneIntoMirror()`,
  which runs with `--git-dir` set to the mirror and reads the clone as a fetch
  source. Those two exports are the enforcement point;
- never edit a pull request body, open, merge or review a pull request. `gh()`
  in `src/gh/gh.ts` is module-private, so every invocation passes `assertAllowed`
  first: two reads and exactly two writes, both issue-comment endpoints, matched
  as whole paths. `PATCH repos/o/r/issues/<n>` - the pull-request body - differs
  from the permitted comment update by one path segment, which is why the
  allow-list is not a list of forbidden verbs;
- no eyes-on process may have a working directory under a foreign worktree - the
  daemon's cwd is always its own state root.

`test/coexistence.test.ts` is where these are enforced. Treat a failure there as
a design violation, not a flaky test.

## Authoritative sources

- **Approved scope, binding**: `~/Projects/firstmate/data/nowy-produkt-przegladu-scope/report.md`.
  Section 2 (the M1-M26 table of what is adopted from no-mistakes and what is
  rejected), section 4 (coexistence), section 7 (language and shape), section 8
  (stage acceptance) and Appendix C (CLI surface, state layout, schema) decide
  design questions. Read it before changing architecture.
- **Evidence behind the decisions**: `~/Projects/firstmate/data/code-review-system-research/report.md`.
- **Patterns worth copying**: the no-mistakes clone at
  `~/Projects/firstmate/projects/no-mistakes`. **Read-only.** Its line numbers in
  comments are from commit `a68298e`; grep for the symbol name rather than
  trusting the line.
- **Measured results**: `docs/stage-2-acceptance.md`, `docs/stage-1-acceptance.md`
  and `docs/stage-0-acceptance.md`. All are anchored by description rather than
  by commit id, because a pull-request SHA does not survive the squash-merge
  that lands it. `docs/stage-2-locality.mjs` re-derives the stage 2 locality
  number; it reads the no-mistakes database through `?mode=ro` and writes
  nothing anywhere.

## Commands

`npm run build` · `npm run typecheck` · `npm run lint` · `npm test` (builds
first) · `npm run genskill`.

## Sharp edges

- **Zero runtime dependencies is deliberate** (report section 7). The TOON
  encoder, the YAML subset and the SQLite access layer are hand-written for that
  reason. Do not add a runtime dependency without revisiting that decision.
- **`node:sqlite` is still experimental** (report R2). Keep `src/db/db.ts` thin so
  the documented fallback stays cheap. The bin entry filters only that one
  warning off stderr, because stderr is the AXI progress channel.
- **The singleton lock is a SQLite database** in `locking_mode=EXCLUSIVE`, because
  Node exposes no `flock`. It is a real kernel lock released on death, including
  SIGKILL - `test/lock.test.ts` proves both against a second process. Do not
  replace it with an `O_EXCL` file plus a pid check. Its holder row reads
  backwards from the obvious: while the lock is held the row cannot be read at
  all, so a *readable* row is a record of a dead holder. `inspectLock` is the
  only place allowed to turn that reading into a claim, and a live holder is
  named from `daemon.pid`, never from the row.
- **The service manager owns the daemon.** `init` installs the service, waits for
  the job it actually started, and only spawns a daemon itself as a fallback.
  Starting one in parallel wins the singleton lock and leaves the managed job
  exiting cleanly forever after.
- **The mirror is a rebuildable cache, not state.** It borrows the clone's objects
  through `objects/info/alternates`, so deleting the clone breaks it by design;
  `doctor` detects that and `init --force` rebuilds it.
- **The CLI surface lives in one table**, `src/cli/commands.ts`. Dispatch, `help`
  and the `/eyes-on` skill are all generated from it, and `test/skill.test.ts`
  fails when the checked-in `skills/eyes-on/SKILL.md` drifts. After changing a
  command, run `npm run genskill`.
- **Unimplemented commands must stay honest.** A stage 2+ command exits 1 naming
  its stage. Never make one return an empty-but-plausible result: an agent would
  report "no risk found" for a change nobody assessed.
- **The scoring constants are the report's, not tuning knobs.** Weights,
  saturation constants and the two thresholds live in `src/risk/repoconfig.ts`
  and come from scope report section 5. Changing one is a decision argued from
  `backtest` over real history - and, from stage 3, `calibrate` - never from
  taste. `test/signals.test.ts` asserts the numbers.
- **A list of paths in a machine payload is a list, never a joined string.**
  `hard_rule_matches` (`check`, `rules --check`) is one row per matched file and
  `dropped_paths` (`export-path-instructions`) is a real array. Git does not
  quote a space, so `deploy/my values.yaml` read back out of a space-joined cell
  becomes two paths that do not exist. This supersedes the space-joined sketch
  in the scope report's Appendix C.4, which is outside this repository; the
  divergence is deliberate. `test/rules.test.ts` proves it with a path that
  contains a space.
- **S1 and S2 count code files only, and hard rules count all files.** The first
  is measured (without it `AGENTS.md` ranks first on adx-worker); the second is
  the point of a hard rule, which must fire for a `deploy/values.yaml` no code
  filter would keep. Both are asserted in `test/check.test.ts` and
  `test/rules.test.ts`.
- **`--no-model` must be unable to reach a model, not merely choose not to.**
  `modelOptionsFor` (`src/cli/model-context.ts`) is the only place the flag is
  read and it returns `null`; every caller checks `null` before building a
  prompt. Adding a second read of the flag would turn a structural guarantee
  into three `if`s that have to stay in agreement. `test/spotlight.test.ts`
  asserts it against a fake agent that records every invocation.
- **`model.command` is the one config field eyes-on executes.** It comes from
  the default branch like every other trusted field, which is the right trust
  level for deciding which paths need a reviewer and not by itself a reason to
  run an arbitrary program a cloned repository names. It must be a **bare name
  in `KNOWN_AGENTS`, resolved through PATH**: a name carrying a path separator
  is refused whatever its basename says, because `tools/claude` would otherwise
  be a program the repository ships and eyes-on runs. Only
  `~/.eyes-on/config.yaml`, which no branch can write, can lift either rule.
  `resolveModelCommand` and `isExecutable` (`src/spot/agent.ts`) resolve a name
  the same way, against the directory `askModel` spawns in, so the check and the
  spawn cannot look at two different files.
- **A prompt the model cannot see the edge of produces a wrong answer, not a
  missing one.** The drift description's diff is cut at a size limit and git
  orders its output by path, so an unmarked cut described a three-thousand-line
  change from its two documentation files and then reported that four of the
  five things it did were missing from it. The first pass is given the complete
  file list, and the prompt says when the diff text is a prefix. Any new prompt
  that truncates anything owes the model the same sentence.
- **Drift is two calls or it is nothing.** The first sees the diff and not the
  intent; the second sees that description and the intent and never the code.
  Collapsing them into one call leaves a command that runs, costs money and
  reports an agreement it never checked. `test/drift.test.ts` asserts the
  separation by reading the prompts that were actually sent.
- **S7 is the grade minus one, and the score can exceed 100.** Feeding the grade
  itself would put eight points on every change whose drift was measured and
  found to be 1 - a change that did exactly what it said. The cost is that S7
  reaches 18 of its 20 points rather than 20, because the report's saturation
  constant is 5 and the raw value tops out at 4. Weights now sum to 1.20 with
  thresholds unchanged, so `maxScore()` - never a literal 100 - is what a
  rendering divides by.
- **`spotlight` ranks code files and hard-rule files, nothing else.** Same
  measured reason as S1/S2: without the code filter a reviewer gets sent to
  `AGENTS.md`. The hard-rule union is the deliberate exception, because a rule
  must reach a `deploy/values.yaml` no code filter would keep.
- **A history walk stops at the base, not the head.** Counting a branch's own
  commits as history lets it raise its own churn signal by committing more often.
- **Every git read goes through `RepoReader`** (`src/git/reader.ts`): refs are
  resolved against the clone, everything else is read by SHA through the mirror,
  which borrows the clone's objects. Do not add a second path into git. Every
  path git reports is passed through `unquoteGitPath` there: git C-quotes any
  path with a non-ASCII byte, and a quoted path matches no glob and blames
  nothing, so a hard rule would silently miss the file it was written for.
- **A state root deeper than `MAX_SOCKET_PATH_BYTES` is refused, not relocated.**
  A unix socket address is truncated rather than refused past the kernel's field
  size, which is why two scratch roots once shared one daemon and `init` under
  one registered into the other. `Paths` refuses such a root where the root is
  resolved, so `Paths.socket` is unconditionally `<root>/socket` and there is
  exactly one address every client derives the same way; see
  `test/paths.test.ts`.
- **A test's state root comes from `stateRoot()` in `test/helpers.ts`, never
  from `os.tmpdir()`.** A deep ambient `TMPDIR` would push every temporary root
  past that limit and fail the suite for a reason unrelated to the code under
  test. `test/cli.test.ts` proves the suite survives a deep `TMPDIR`.
- **A test that runs `init` must stop the daemon it started.** The temporary
  state root goes away with the test process; the daemon does not.
- **Tests may never touch a real state root.** `Paths.fromEnv()` refuses the
  default root under the test runner. Tests that install a skill or a service
  must set `EYES_ON_SKILL_ROOT` and `EYES_ON_SKIP_SERVICE_MANAGER=1`. A test
  that mutates state also needs a private `NM_HOME` and no inherited
  `NO_MISTAKES_GATE`, or the recursion guard reads the suite - which itself runs
  from a gate worktree - as a pipeline descendant and refuses.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
