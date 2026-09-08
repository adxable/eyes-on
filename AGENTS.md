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
- never edit a pull request body, open, merge or review a pull request. **No
  caller anywhere writes a gh argument vector.** A caller names one of seven
  `GhOperation`s and `src/gh/gh.ts` holds the seven vectors literally; five read
  and two write, both issue-comment endpoints. `doctor`'s credential probe is
  one of the seven - `ghAuthenticated` lives there - so the rule has no
  exception to remember. The seventh is stage 3's `pull-record`, a bare GET of
  the pull request with no `--jq` at all: its fields are picked out and checked
  in TypeScript, so a name GitHub did not send is reported as missing rather
  than arriving as a silent null out of a jq expression nobody can see failing.
  `PATCH repos/o/r/issues/<n>` - the pull-request body - differs
  from the permitted comment update by one path segment and simply has no
  operation, so no vector for it exists. This replaced an allow-list that
  parsed the vector, and the reason is the shape rather than the two bugs: the
  parser had to reproduce `gh api`'s own argument semantics, and two rounds
  found divergences from it - `-XPATCH` read as a GET, then the implicit method,
  where `--input` with no `--method` is sent as a POST. `argvFor` validates the
  only tokens a caller influences, the slug and the number, before placing
  them, and `assertAllowed` checks the finished vector against the same table;
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
- **Measured results**: `docs/stage-3-acceptance.md`,
  `docs/stage-2-acceptance.md`, `docs/stage-1-acceptance.md` and
  `docs/stage-0-acceptance.md`. All are anchored by description rather than by
  commit id, because a pull-request SHA does not survive the squash-merge that
  lands it. Three scripts re-derive the numbers, and none of them writes into a
  repository it reads: `docs/stage-2-locality.mjs` (it reads the no-mistakes
  database through `?mode=ro`), `docs/stage-3-selfsufficiency.mjs`, which drives
  `eyes-on label --dry-run` rather than reimplementing the link, with `NM_HOME`
  pointed at an empty directory so the no-mistakes database is unreachable
  rather than merely unused, and `docs/stage-3-register.mjs`, which is behind
  section 4's register, leaks and calibrate tables. The last two **do** write,
  each into a temporary state root of its own which it deletes afterwards: the
  second runs `eyes-on init`, and the third adds `check` and a real, non-dry-run
  `label`. The reference repository is only ever read.

## Commands

`npm run build` · `npm run typecheck` · `npm run lint` · `npm test` (builds
first) · `npm run genskill`.

## Every recorded fact carries what it was recorded against

This governed stage 3 and governs everything after it, and it is here because
the same shape broke five review rounds in a row, once per fact:

- a **drift grade** measures the pair (diff, intent), so `drift_intent` is
  recorded beside it and `carryDrift` decides whether it still answers the
  question being asked;
- a **score** is only meaningful against the weights it was computed under, so
  `score_max` is recorded beside it and no renderer recomputes a denominator;
- a **gate decision** answers a set of hard-rule hits, so `hits_fingerprint` and
  `config_sha` are recorded beside it and `decisionCovering` (`src/db/gate.ts`)
  is what every surface asks - never "is there a decision";
- a **published comment** carries an assessment, so `prs.check_id` records which
  one; a head alone does not name a check keyed on (repository, base, head);
- a **register line** describes a merged change, so `src/ledger/ledger.ts`
  carries every one of the above at once, plus three of its own: `band_from`,
  because a band a hard rule forced does not move when a threshold moves and
  `calibrate` holds those rows at `pelna`; `check_source`, which of the four
  ways `label` found the assessment, which the row cannot be asked afterwards;
  and the whole `link` - both sources' shas and whether they agreed, never one
  merged answer.

When a later run's context differs, the recorded fact **does not apply**: the
grade is superseded, the run parks again. Adding a column for symmetry is not
the rule - the rule is about what can come apart. Two facts already carry their
context and need nothing: `spots` rows carry `check_id` and `source` (which
assessment, which stage chose the fragment), and `blame_cache` is keyed on the
fix commit whose blame it holds, which never changes; the trusted config decides
only whether a commit is a *fix*, and that decision is taken before the cache is
consulted.

## Sharp edges

- **A gate decision is evidence about the rules it was shown, and nothing
  else.** `respond` accepts an answer on a run no rule parked - a deliberate
  answer about a change nobody had to read is still a fact - so asking only
  whether a decision row exists let that answer, or one given while the trusted
  config was unreadable and *no* rule could be evaluated, pre-answer a rule that
  fired later; the pull request then published a waiver against a rule nobody
  was shown. `hitsFingerprint` names the set, `recordDecision` stores it and
  `statusFor` compares it, so a change whose rule set moves parks again while a
  genuinely answered gate never reopens. `test/gate.test.ts` covers both
  directions.
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
- **A signal goes to a pid only after the process behind it is identified, and
  nothing is removed before that process is gone.** `daemon stop` also ends a
  *wedged* daemon - a live holder of the lock whose socket answers nothing - and
  `identifyDaemonProcess` (`src/daemon/identity.ts`) is the single gate every
  signal passes: the kernel recycles pid numbers, so the holder named by the
  lock record has to be running `daemon run --root <this root>` and cannot have
  started after that record was written. A holder that does not confirm is
  refused, with the reason and no signal sent - a correct answer, not a failure
  to try harder - and so is one this process may not signal. The socket path
  reaches the same gate: a daemon that was asked to exit and did not is
  signalled through `signalHolder`, against the lock record read *after* the
  wait, never the pid the health response gave before it. SIGKILL is reached
  only through `--force`. The socket file, the holder record and the pid file
  are cleared only after the process is confirmed gone *and* the lock is
  confirmed free: earlier, the socket is the path a live daemon would answer on
  and the lock is somebody's singleton. `test/stop.test.ts` measures every
  branch.
- **The service manager owns the daemon.** `init` installs the service, waits for
  the job it actually started, and only spawns a daemon itself as a fallback.
  Starting one in parallel wins the singleton lock and leaves the managed job
  exiting cleanly forever after. The same ownership decides what a stop may
  claim, and the claim follows evidence rather than the job being loaded. Those
  jobs restart on failure only, and the daemon handles SIGTERM and exits 0, so
  an ordinary stop on a managed root is a `stopped`. Two readings are not:
  a lock held by a process `identifyDaemonProcess` confirms is this root's
  daemon is `replaced`, and a lock left free by a **SIGKILL** - the one exit this
  command knows was unsuccessful - is `service-managed`. `inspectService` is
  asked only to name the job in the sentence; it never decides an outcome or an
  exit code, and a holder nobody could confirm stays `lock-still-held` at exit 1
  whatever the manager holds.
- **The mirror is a rebuildable cache, not state.** It borrows the clone's objects
  through `objects/info/alternates`, so deleting the clone breaks it by design;
  `doctor` detects that and `init --force` rebuilds it.
- **The CLI surface lives in one table**, `src/cli/commands.ts`. Dispatch, `help`
  and the `/eyes-on` skill are all generated from it, and `test/skill.test.ts`
  fails when the checked-in `skills/eyes-on/SKILL.md` drifts. README's table is
  written by hand, because its right-hand column is prose rather than the
  registry's summaries, so the same test parses it and fails when its
  invocations stop matching `implementedCommands()` - four review rounds found a
  flag in the registry and not in README. After changing a command, run
  `npm run genskill` and update that table.
- **A command nobody built and a command that is answered are different, and
  both must stay honest.** An *unimplemented* stage 2+ command exits 1 naming
  its stage, and must never return an empty-but-plausible result: an agent would
  report "no risk found" for a change nobody assessed. `axi abort` is the other
  case - it is answered, not missing: eyes-on has no in-flight run to abort,
  because a check is synchronous and a parked gate is released by answering it,
  so it exits 2 saying that and stays on the command surface for an agent
  following the report's Appendix C.1. Do not turn that true answer back into a
  stub promising a stage that has already shipped.
- **The scoring constants are the report's, not tuning knobs.** Weights,
  saturation constants and the two thresholds live in `src/risk/repoconfig.ts`
  and come from scope report section 5. Changing one is a decision argued from
  `backtest` over real history - and, from stage 3, `calibrate` - never from
  taste. `test/signals.test.ts` asserts the numbers.
- **A score is measured against a clock, so a re-run of an acceptance sweep does
  not reproduce it exactly.** The recency signal reads `nowSeconds`, so a change
  scores lower as the files behind it age; `docs/stage-3-register.mjs` re-run
  four days later moved the register's top score from 95 to 93 with the bands,
  the median and the row count unchanged. `leaks` moves for a second reason -
  `window has not elapsed` puts the newest merges outside the denominator - so
  an acceptance document quoting either has to name the day it measured.
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
  let it choose what runs. Narrowing that one dimension at a time did not hold -
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
  directory is the same vector as the argv in another disguise: a coding agent
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
- **The file-level leak variant is refused by name, never merely absent.**
  `leaks` recognises `--file-level`, `--files`, `--file` and `--variant` and
  exits 2 saying the variant does not exist and why: its base rate is 45-73%,
  so every channel scores nearly the same and no threshold can be argued from
  it. Ignoring the flag would satisfy the acceptance condition's letter and
  fail its point - a caller who passed it would believe they got what they
  asked for. The reasoning is written out at the top of `src/ledger/leaks.ts`
  because the variant is a two-line simplification of the code beneath it and
  looks like an optimisation to anybody who has not seen the base rate.
- **A merge time is a committer date, never an author date, and so is a fix
  time.** For a squash merge the author date is when the branch's first commit
  was written, days earlier; the committer date is when it landed. `merged_at`
  takes GitHub's own answer when gh was read and falls back to
  `CommitRecord.committed`, and the leak window starts there. Both ends of that
  window read the same clock: `FixAttribution.committed` is what `leaks`
  measures the fix side by, because a branch written before the change it fixes,
  rebased onto it and landed afterwards has an author date *earlier* than the
  merge it blames into, and a negative elapsed drops a real leak.
- **Who is in the leak denominator is decided in one place, and the answer
  carries whether time undoes it.** `classifyMerge` (`src/ledger/population.ts`)
  is that place; `measureLeaks` builds the denominator from it, `calibrate`
  sweeps the population that measurement produced rather than re-deriving
  eligibility, and `label` asks it about the row it just wrote so the command a
  person runs per merge says what `leaks` will do with it. A denominator holding
  changes that structurally cannot leak - or that were never given the time to -
  understates every rate in the table at once, so two rules exclude rather than
  count clean. *Blame can never name a true merge commit*: it introduces no
  line. The parent count behind that is one rule asked of whichever source can
  answer it - the register row, and otherwise the object store - because a row
  written from GitHub's `merge_commit_sha` alone carries none, which on a
  `--no-ff` repository is every row. *A merge whose `--window` has not elapsed*
  has had part of the period the rest of the denominator was given, and it is
  the only reason that returns. `EXCLUSION_KINDS` declares three things beside
  each reason - whether it is permanent, why blame cannot be attributed, and the
  outlook: the remedy that really clears it or the explicit fact that nothing
  does - and every surface *renders* that text rather than writing its own
  sentence about it. A merge can satisfy several reasons at
  once, so each one also declares `binding` and `classifyMerge` returns the most
  binding applicable reason rather than the first tested - the order of the
  tests decides nothing, and a reason with a remedy is never reported until it
  is known that no more binding one applies, which is what the one git read per
  row is paid for. `permanent` means the clock alone, so four of the five
  permanent reasons carry a real remedy - label the pull request again, fetch
  the branch, widen `--since` - that a surface must not turn into "nothing can
  be done"; only the true merge commit is cleared by nothing. `sampleVerdict`
  (`src/ledger/sample.ts`) takes the population beside the channels for the same
  reason: a full register none of whose rows has had its window yet is the
  ordinary first state of the product, and it must not read as an empty one. It
  takes the *question* beside them because two commands ask different things of
  one register: `leaks` measures what happened, so its channels are the ones the
  denominator has merges in, while `calibrate` moves thresholds and can move
  merges into a band that is empty today, so all three bands are a real
  destination whose size matters. Two headers over one register are two answers,
  each naming its own population in words, not a contradiction to unify - a
  review round was lost to each module documenting the opposite rule with a
  correct-sounding justification. Do not make the numbers agree; make each
  sentence say which population it counted.
- **The register is append-only and every reader takes the newest.**
  `appendRecord` writes one line; nothing rewrites one. Re-labelling is
  ordinary - a gate answered after the merge, a check re-run - and both lines
  survive. `latestPerPull` is the single place that chooses, so two surfaces
  cannot pick different rows for one pull request. A line this build cannot
  read is counted in `skipped` and reported, never fatal: a register a later
  version wrote into must still be readable by this one.
- **`calibrate` sweeps one score scale.** A threshold compared with a score
  computed under different weights compares two different numbers wearing one
  name, which is what `score_max` beside every score exists to make visible.
  Rows on another maximum are set aside and counted in `other_scales`, and rows
  a hard rule forced to `pelna` are held there at every pair on the grid.
- **A threshold pair that ties with the one in force is not a candidate.** The
  sweep ranks on two numbers - what the `auto` channel leaks and how much
  reading is paid - and neither can tell `wskazane` from `pelna`, so every pair
  that only moves the boundary between the two reading channels scores exactly
  what the current pair scores. Ranking those by anything else named 35/120
  beside a current 35/65 on the reference register: arithmetically identical,
  and an instruction to abolish the full-review channel for no measured gain.
  `chooseCandidate` (`src/ledger/calibrate.ts`) requires a strictly lower read
  share, and the refusal says how many pairs tied.
- **A duration flag is read with `flagDuration` and never with `flagString`.**
  `DURATION_FLAGS` (`src/cli/args.ts`) is the declaration that makes that
  structural, exactly as `NUMERIC_FLAGS` is: `Number.parseInt('14d')` is 14 and
  discards the unit without a sign of having done so, so `--window` read as a
  string would silently mean days whatever was written. A bare number is
  refused rather than assumed, because `--window` and `--since` default to
  different spans.
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
