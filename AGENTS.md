# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## What this product is, and what it must never do

eyes-on decides **what a human has to read** in a change before it is merged. It
runs beside no-mistakes and is not a fork, a plugin or a competitor.

The prohibitions below are the product, not defensive coding. Breaking one is a
correctness bug even when everything still passes:

- never write anything under `~/.no-mistakes/**`, and never install a hook in the
  no-mistakes gate or use its `pre-receive.no-mistakes-user` slot;
- never write a ref, an index entry, a remote or a config value into a working
  clone. `git()` in `src/git/git.ts` is module-private, so a clone is reachable
  only through `gitReadClone()`, which refuses any subcommand outside the
  allow-list and refuses the write forms of the three that can go either way
  (`config`, `remote`, `symbolic-ref`), or through `fetchCloneIntoMirror()`,
  which runs with `--git-dir` set to the mirror and reads the clone as a fetch
  source. Those two exports are the enforcement point;
- never edit a pull request body, open, merge or review a pull request;
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
- **Measured stage 0 results**: `docs/stage-0-acceptance.md`.

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
  replace it with an `O_EXCL` file plus a pid check.
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
- **Unimplemented commands must stay honest.** A stage 1+ command exits 1 naming
  its stage. Never make one return an empty-but-plausible result: an agent would
  report "no risk found" for a change nobody assessed.
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
