# eyes-on

A local daemon that computes, from a repository's own history, **whether and what
a human must read** in a change before it is merged, records that decision as a
durable record, and after the merge checks whether the decision was right.

It runs beside no-mistakes and never modifies it. no-mistakes is responsible for
the code being good; eyes-on is responsible for a human reading the part that
matters, and for making it possible to check afterwards whether the threshold
was set correctly.

## Status: stage 1

Stage 1 delivers the product's reason for existing: a risk score computed from
repository history, and hard rules on sensitive paths. Stage 0 before it built
the skeleton - the state root, the daemon, the mirror, the command surface and
the agent skill.

**The fragment ranking and the intent-drift signal are not implemented yet**;
they arrive in stage 2, and the `drift` signal is reported with a weight of zero
rather than hidden. Commands that belong to a later stage are listed and
documented, and report the stage that will deliver them - they never return a
made-up answer.

Measured acceptance results: [stage 1](docs/stage-1-acceptance.md),
[stage 0](docs/stage-0-acceptance.md).

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
| `eyes-on check [--base <ref>] [--head <ref>] [--strict]` | Score the change and apply the hard rules |
| `eyes-on why <file>` \| `eyes-on why --top <n>` | Where one file's risk came from, or where risk lives in the repository |
| `eyes-on rules --check` | The hard rules alone, read from the default branch |
| `eyes-on export-path-instructions` | A `review.path_instructions` block for `.no-mistakes.yaml` |
| `eyes-on backtest --split <date>[,<date>...]` | Whether the signal knew anything, on this repository's own history |
| `eyes-on axi [status\|check]` | The agent surface |

`spotlight`, `drift`, `comment`, `label`, `leaks` and `calibrate` arrive in
stages 2 and 3. `eyes-on help` prints the full surface with the stage that owns
each one.

## How the score is built

Seven signals, each normalised by `min(1, ln(1+x)/ln(1+K))` and summed with its
weight, times 100. Two thresholds turn the number into a band: under 35 needs no
reading, 35 to 64 means read the indicated fragments, 65 and over means a full
review.

| signal | weight | K | what x counts |
|---|---|---|---|
| `fix_history` | 0.30 | 5 | fix commits whose removed lines blame into the file |
| `churn` | 0.20 | 20 | commits touching the file in the window |
| `size` | 0.20 | 400 | lines added and removed in code files |
| `spread` | 0.10 | 12 | directories the change reaches into |
| `no_test` | 0.15 | 1 | share of changed code files with no test changed beside them |
| `recency` | 0.05 | 30 | days of freshness: 30 is touched today, 0 is untouched for a month |
| `drift` | 0.00 | 5 | intent against diff - stage 2 |

Three rules about it are not adjustable and are the product rather than the
implementation:

- **fix history and churn are counted over code files only.** Without that, the
  riskiest file in a repository is its `AGENTS.md`, and a reviewer sent there
  learns to ignore the ranking. Measured, not assumed - see the stage 1
  acceptance document.
- **hard rules are read from the default branch at a pinned commit**, never from
  the branch being assessed, and they match the full changed-file list before any
  filter. A branch that deletes a rule still gets it.
- **nothing blocks.** `check` exits 0 whatever the band is and whatever the rules
  say. `--strict` exists for a caller who has explicitly asked otherwise, and it
  is the only thing that produces a non-zero exit.

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
```

Every field is optional and the shipped defaults are the report's. A file that
exists and cannot be parsed is not treated as an empty one: the check is
reported `unverified`, carrying the parse error, because a rule that cannot be
read is not the same as a rule nobody wrote.

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
