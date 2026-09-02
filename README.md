# eyes-on

A local daemon that computes, from a repository's own history, **whether and what
a human must read** in a change before it is merged, records that decision as a
durable record, and after the merge checks whether the decision was right.

It runs beside no-mistakes and never modifies it. no-mistakes is responsible for
the code being good; eyes-on is responsible for a human reading the part that
matters, and for making it possible to check afterwards whether the threshold
was set correctly.

## Status: stage 2

Stage 2 answers the second half of the question. Stage 1 says *whether* a human
has to read a change; stage 2 says *what* - three to five fragments, ranked from
the repository's history and then chosen by one model call - compares the diff
with the intent its author stated, parks a change a hard rule protects until
somebody records a decision about it, and publishes the result as a single
sticky pull-request comment.

The ledger and the leak measurement (`label`, `leaks`, `calibrate`) arrive in
stage 3. Commands that belong to it are listed and report the stage that owns
them; they never return a made-up answer.

Measured acceptance results: [stage 2](docs/stage-2-acceptance.md),
[stage 1](docs/stage-1-acceptance.md), [stage 0](docs/stage-0-acceptance.md).

## Install

```sh
npm i -g @adxable/eyes-on     # requires Node >= 22.5
eyes-on init                  # register this repository
eyes-on doctor                # what is available, and what is degraded
```

`eyes-on init` creates the state root, builds the repository mirror, starts the
daemon, registers it with the OS service manager and installs the `/eyes-on`
agent skill. It is idempotent: running it again repairs what is missing and
leaves a healthy install alone. `eyes-on init --watch` additionally installs a
`post-commit` hook in the clone, preserving any hook already there.

## Available now

| Command | What it does |
|---|---|
| `eyes-on init [--watch] [--force]` | Register the repository; idempotent |
| `eyes-on doctor` | Readiness, degradations, and collisions with no-mistakes |
| `eyes-on status` | Daemon and registered repositories |
| `eyes-on daemon {start\|stop\|restart\|status\|run --root <dir>\|notify-commit}` | Manage the daemon |
| `eyes-on check [--base <ref>] [--head <ref>] [--default-branch <ref>] [--intent "..."] [--no-model] [--strict] [--format toon\|md\|json]` | Score the change, apply the hard rules, and with an intent measure the drift |
| `eyes-on spotlight [--base <ref>] [--head <ref>] [--default-branch <ref>] [--n 5] [--intent "..."] [--no-model]` | The three to five fragments a human should actually read |
| `eyes-on drift [--base <ref>] [--head <ref>] [--default-branch <ref>] [--intent "..."] [--no-model]` | What the diff does, against what its author said it would |
| `eyes-on comment --pr <n> [--check-id <id>] [--base <ref>] [--head <ref>] [--default-branch <ref>] [--dry-run]` | One sticky comment on the pull request; never the body |
| `eyes-on why <file>` \| `eyes-on why --top <n> [--default-branch <ref>]` | Where one file's risk came from, or where risk lives in the repository |
| `eyes-on rules --check [--strict] [--base <ref>] [--head <ref>] [--default-branch <ref>]` | The hard rules alone, read from the default branch |
| `eyes-on export-path-instructions [--min-risk <0-100>] [--default-branch <ref>]` | A `review.path_instructions` block for `.no-mistakes.yaml` |
| `eyes-on backtest --split <date>[,<date>...] [--horizon <days>] [--default-branch <ref>]` | Whether the signal knew anything, on this repository's own history |
| `eyes-on axi {status\|check\|logs [--lines <n>]\|respond --action read\|waive --reason "..." [--check-id <id>] [--by <name>]} [--base <ref>] [--head <ref>] [--default-branch <ref>]` | The agent surface, including the `must_read` gate |

`label`, `leaks` and `calibrate` arrive in stage 3. `eyes-on help` prints the
full surface with the stage that owns each one.

## What to read, and whether it matches the intent

```sh
eyes-on check --intent "why this change was made, not what it changes"
eyes-on spotlight              # three to five fragments, with a sentence each
eyes-on comment --pr 42        # one sticky comment; the body is never touched
```

`spotlight` is two stages and the split is not an optimisation. Stage one is
arithmetic over git - `file_risk x hunk size x 2 (hard rule) x 1.5 (lines a past
fix blamed) x 1.2 (no test)` - and it narrows the diff to twelve candidates.
Stage two is **one** model call that picks three to five of them and writes a
sentence about each. The median commit in the reference repository is 604 lines,
which a model handed the whole change does not read.

`--no-model` returns stage one alone and calls no model at all. It is the path
that has to work when the model is rate-limited, so it is a complete answer
rather than a degraded one; the payload's `stage` field says which you got, and
a stage-one fragment carries no category because the arithmetic does not know
what kind of thing it found.

`drift` is two model calls against anchoring: the first describes the diff
**without being shown the intent**, the second compares that description with the
intent and never sees the code. The grade is 1 (the change does what it said) to
5 (they are about different things), and it is shown rather than enforced: the
`drift` command exits 0 at every grade. It does raise the risk score through S7,
and the band follows the score, so under `eyes-on check --strict` - a caller
explicitly asking for a non-zero exit on a `pelna` band - drift can carry a
change over the threshold like any other signal. Without `--strict` no grade
changes an exit code.

## When a hard rule fires

A hard rule sets the band to `pelna` and **parks the check as `must_read`**. The
park holds nothing up outside eyes-on: no exit code moves, no push waits, no
pull request goes red. What it does is refuse to call the change decided until
somebody records what they decided:

```sh
eyes-on axi respond --action read
eyes-on axi respond --action waive --reason "why this is safe to merge unread"
```

A waiver with no reason is refused. The decision, the reason, who gave it and
**which rule hits it answered** are written down, which is what turns the channel
label from a declaration into evidence - and is what stage 3's ledger reads. A
decision answers the rules it was shown: answer a change no rule matched, then
add a rule that reaches it, and the change parks again rather than arriving
pre-waived.

## How the score is built

Seven signals, each normalised by `min(1, ln(1+x)/ln(1+K))` and summed with its
weight, times 100. Two thresholds turn the number into a band: under 35 needs no
reading, 35 to 64 means read the indicated fragments, 65 and over means a full
review.

The six signals computed from history total exactly 100 between them. Drift adds
its 0.20 on top rather than displacing them - the report keeps the thresholds at
35 and 65 - so a change whose diff does something its intent never mentioned can
score above 100. Every rendering divides by what the weights actually allow
rather than by a hard-coded hundred. A change nobody has ever measured a grade
for carries S7 = 0 and scores exactly what it would have at stage 1. A run that
measures none itself - `--no-model`, a rate-limited model, or a `check` with no
`--intent` - is not that case: not measuring is not changing, so it carries the
grade already recorded for the same intent and says, in every payload and every
rendering, that the grade came from an earlier measurement rather than from this
run. A grade measured against a **different** intent is not carried: the author
changed what the change is for, so the old verdict answers a different question
and S7 falls back to zero.

| signal | weight | K | what x counts |
|---|---|---|---|
| `fix_history` | 0.30 | 5 | fix commits whose removed lines blame into the file |
| `churn` | 0.20 | 20 | commits touching the file in the window |
| `size` | 0.20 | 400 | lines added and removed in code files |
| `spread` | 0.10 | 12 | directories the change reaches into |
| `no_test` | 0.15 | 1 | share of changed code files with no test changed beside them |
| `recency` | 0.05 | 30 | days of freshness: 30 is touched today, 0 is untouched for a month |
| `drift` | 0.20 | 5 | intent against diff, above an aligned grade of 1 |

Three rules about it are not adjustable and are the product rather than the
implementation:

- **fix history and churn are counted over code files only.** Without that, the
  riskiest file in a repository is its `AGENTS.md`, and a reviewer sent there
  learns to ignore the ranking. Measured, not assumed - see the stage 1
  acceptance document.
- **hard rules are read from the default branch at a pinned commit**, never from
  the branch being assessed, and they match the full changed-file list before any
  filter. A branch that deletes a rule still gets it.
- **nothing blocks unless the caller asks it to.** Without `--strict`, `check`
  exits 0 whatever the band is, whatever the rules say and whatever the drift
  grade is. `--strict` is the caller asking to gate on a `pelna` band, and it is
  the only thing in the product that produces a non-zero exit. Nothing eyes-on
  publishes reddens a pull request or holds up a merge either way.

Every score comes with the evidence: which signal contributed how many points,
which file decided it, and - through `eyes-on why <file>` - the fix commits, by
subject and date, that pointed at a file in the first place.

## Configuring a repository

Everything above works with no configuration. A repository that wants hard rules
or its own idea of a code file adds `.eyes-on.yml` at its root, on its default
branch - that is the copy eyes-on reads:

```yaml
schema: eyes-on/v1
hard_rules:
  - glob: "deploy/**"
    why: "a deployment change is read by a human, whatever the score says"
include: ["**/*.{ts,tsx,go,py}"]     # what counts as a code file
exclude: ["**/dist/**"]              # ...and what never does
history_window_days: 90
fix_commit_pattern: "^(fix|hotfix)(\\(|:|!)"
weights: { fix_history: 0.30 }       # argued from `backtest`, never from taste
saturation: { fix_history: 5 }
thresholds: { read_fragments: 35, full_review: 65 }
model:
  agent: claude                      # "" opts this repository out of the model
  max_hunks: 12                      # candidates the second stage is given
```

Every field is optional and the shipped defaults are the report's. A file that
exists and cannot be parsed is not treated as an empty one: the check is
reported `unverified`, carrying the parse error, because a rule that cannot be
read is not the same as a rule nobody wrote.

`model.agent` is the one field that reaches process execution, so a repository
chooses only the **name**, resolved through PATH, and eyes-on holds the whole
argument vector that name maps to. The name it will run is `claude`, and only
that one: `codex`, `copilot`, `cursor-agent`, `opencode`, `pi` and `rovodev` are
names eyes-on recognises and **refuses to run**, because it holds no invocation
for them that anybody has verified - see below. Narrowing this one dimension at a time did
not hold - first the program's path, then its name, then its flags - and the
prompt those flags govern is built from the same repository's diff, so
`claude -p --dangerously-skip-permissions` would be a cloned repository handing
itself an agent with broad permissions and attacker-controlled input. There is
now nothing left for it to choose.

The agent is also started in a directory eyes-on owns, under the state root,
rather than in the clone. A coding agent reads the settings and instruction
files of the directory it starts in, and those would be the assessed branch's.
It stops reading them: the prompt arrives on stdin and carries the whole input,
so the fragments and the drift grade are computed from the text eyes-on supplies
and from nothing the repository can add.

`claude` is the only name with an argument vector, because `claude -p` is the
only invocation exercised here; a repository naming one of the others is told
that, and pointed at the escape below, rather than given a guessed flag. `model.command` - the whole argv -
is honoured only when `model: { allow_any_command: true }` is set in
`~/.eyes-on/config.yaml`, the machine's own file, which no branch can write.
Without it a repository carrying `model.command` is refused by name and the
command falls back to stage one.

## Output contract

- Machine payload on **stdout**: TOON by default under `axi`, Markdown elsewhere;
  `--format toon|json|md` overrides it.
- Progress on **stderr**. Never parse stderr.
- Exit `0` success or no-op, `1` error, `2` usage error.
- Every failure carries `error:` and `help:`.

## What eyes-on never does

It does not review or change code, create refs, commit, push, open or merge pull
requests, edit a pull request body, run tests, lint or CI, or block anything. It
writes nothing into `~/.no-mistakes` and no ref into your working clone: fresh
objects are fetched only into its own mirror, which borrows the clone's object
store through `objects/info/alternates` rather than copying it.

That guarantee is about eyes-on's own writes, and it is stated no wider than it
is enforced. A local agent is a separate process running with your environment,
and eyes-on does not sandbox it. What eyes-on controls is what it hands that
process: a working directory under its own state root, one prompt on stdin, and
nothing that points at your clone.

The pull-request prohibition is enforced rather than intended: every `gh`
invocation passes an allow-list of two comment endpoints before a process is
spawned, and the endpoint that would edit a pull request body differs from the
comment update eyes-on is allowed to make by a single path segment. The body
belongs to no-mistakes, which regenerates it on every update; eyes-on writes one
comment, finds it again by its marker, and edits that.

Called from inside a no-mistakes pipeline run, eyes-on refuses to record
anything and says so. Read-only commands keep working there.

## Development

```sh
npm install
npm run build       # tsc
npm run typecheck
npm run lint
npm test            # builds, then runs the suite
npm run genskill    # regenerate skills/eyes-on/SKILL.md from the command registry
```

Tests must never touch a real state root: `Paths.fromEnv()` refuses the default
root under the test runner unless `EYES_HOME` is set.
