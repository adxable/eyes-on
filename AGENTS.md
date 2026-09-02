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
- **eyes-on itself** never writes a ref, an index entry, a remote or a config
  value into a working clone. `git()` in `src/git/git.ts` is module-private, so
  a clone is reachable only through `gitReadClone()`, which refuses any
  subcommand outside the allow-list and refuses the write forms of the three
  that can go either way (`config`, `remote`, `symbolic-ref`), or through
  `fetchCloneIntoMirror()`, which runs with `--git-dir` set to the mirror and
  reads the clone as a fetch source. Those two exports plus `Paths` - which
  every other write goes through - are the enforcement point. This prohibition
  covers two actors and only one of them is ours to enforce: a spawned agent is
  a separate process with the user's environment, and no allow-list of ours can
  stop an arbitrary program from writing to an arbitrary path. eyes-on has no
  sandbox, so the honest guarantee is stated at the granularity it is enforced
  at - eyes-on's own writes are structural, and what eyes-on controls about the
  agent is the environment it hands it: a working directory under its own state
  root, a prompt on stdin, and nothing pointing at the clone. Do not restate
  this as "nothing eyes-on runs writes into a clone";
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
  `modelOptionsFor` (`src/cli/model-context.ts`) is the only place the flag
  *decides* anything: it returns `null`, and every caller checks `null` before
  building a prompt, so there is no branch that reaches `askModel` with the flag
  set. Three commands read the flag again, but only to choose what their output
  says about a model they were already unable to call. Keep it that way - a
  second read that decides reachability would turn a structural guarantee into
  several `if`s that have to stay in agreement. `test/spotlight.test.ts` asserts
  it against a fake agent that records every invocation.
- **A repository picks an agent by name; eyes-on owns the argv.** `.eyes-on.yml`
  comes from the default branch like every other trusted field, which is the
  right trust level for deciding which paths need a reviewer and not a reason to
  let it choose what runs. Narrowing that one dimension at a time failed twice -
  the program's path, then its name, then its flags - so the choice is closed
  rather than filtered: `model.agent` names one entry of `AGENT_ARGV`
  (`src/spot/agent.ts`) and eyes-on holds the whole vector. `AGENT_ARGV` carries
  only `claude`, because only `claude -p` has been exercised; a recognised name
  without a vector is refused rather than given a guessed flag. `model.command`
  runs as given only under `allow_any_command` in `~/.eyes-on/config.yaml`,
  which no branch can write, and is otherwise refused by name rather than
  ignored. `isExecutable` resolves against the directory `askModel` spawns in,
  so the check and the spawn cannot look at two different files.
  `test/spotlight.test.ts` asserts the argv the stub was actually invoked with.
- **The agent starts in `Paths.agentDir`, never in the clone.** The working
  directory is the same vector as the argv in a third disguise: a coding agent
  reads the settings and instruction files of the directory it starts in, so a
  branch adding `.claude/settings.json` and a `CLAUDE.md` would be configuring
  the process eyes-on spawns over that same branch's diff. `modelOptionsFor`
  (`src/cli/model-context.ts`) is the one place a cwd is chosen and it chooses
  a directory under the state root. The prompt is on stdin and carries the whole
  input, so the agent needs nothing from the repository; `test/spotlight.test.ts`
  asserts the directory the stub was actually run in.
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
- **A drift grade measures the pair (diff, intent); the row is keyed without the
  intent.** `checks` is keyed on (repository, base, head), so the intent it was
  measured against is recorded beside the grade in `drift_intent` and travels
  with it. `carryDrift` (`src/risk/signals.ts`) is the single place that decides
  between measured, carried and superseded, and `driftProvenanceSentence` is the
  single place that says which - four commands read both. Not measuring is not
  changing: a run that took no measurement moves none of the four recorded facts
  and deletes no `drift_items`. A run stating a *different* intent is the
  exception, because the previous verdict answers a different question: the
  grade is dropped through `supersedeDrift` rather than inherited, and that run
  does move the numbers and must say so. This broke on four consecutive review
  rounds, once per surface; `test/drift.test.ts` covers all three cases. Do not
  add a second helper that decides provenance from a grade alone - one that
  ignored the intent is exactly what was removed.
- **`unverified` travels with the assessment like the score does.** It means the
  trusted config could not be read, so `assess` ran with *no* hard rules and the
  band is a floor - which is exactly what a reader of a published channel cannot
  guess. `unverifiedSentence()` (`src/risk/signals.ts`) is the single wording,
  `check`, `status`, `axi respond` and the pull-request comment all print it,
  and the marker payload carries the flag. `statusFor` gives it precedence over
  the gate, so `recordDecision` leaves it alone: answering a gate says what a
  person decided, not that an unreadable configuration became readable.
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
