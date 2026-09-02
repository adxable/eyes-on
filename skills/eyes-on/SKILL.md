---
name: eyes-on
description: Find out what a human actually has to read in a change before it is merged - risk computed from repository history, hard rules on sensitive paths, and the specific fragments a reviewer should actually look at. Use when preparing a change for review, deciding whether a change needs human eyes, or when the user invokes /eyes-on.
user-invocable: true
---

# eyes-on

eyes-on answers one question: **does a human need to read this change, and if so, which parts?**

It computes risk from the repository's own history, applies hard rules to sensitive paths, records the
decision as a durable record, and after the merge checks whether the decision was right.

## What eyes-on is not

It does not review code, fix code, commit, push, open or merge pull requests, edit a pull request body,
run tests or lint, or block anything. Those belong to no-mistakes and to CI. eyes-on runs beside them and
writes nothing into their state. If you want your change validated and shipped, that is `/no-mistakes`;
this skill tells you what a reviewer must look at.

## Commands available now

| Command | What it does |
|---|---|
| `eyes-on init [--watch] [--force]` | Register this repository: create the state root, build the mirror, start the daemon and install the /eyes-on skill. Idempotent - re-running repairs. --watch also installs a post-commit hook in the clone. |
| `eyes-on doctor` | Report git, node and gh availability, mirror reachability, daemon and service state, and any collision or degradation eyes-on can detect. |
| `eyes-on status` | Show the daemon, the registered repositories and the current head of this repository. Read-only. |
| `eyes-on daemon {start|stop|restart|status|run --root <dir>|notify-commit}` | Manage the eyes-on daemon. `run` is the foreground entry point the OS service invokes. |
| `eyes-on axi {status|check|logs|respond --action read|waive --reason "..."}` | Agent surface: TOON on stdout, progress on stderr, exit 0 success, 1 error, 2 usage error. `respond` answers a run parked by a hard rule and records who decided what, and why. |
| `eyes-on check [--base <ref>] [--head <ref>] [--intent "..."] [--no-model] [--strict] [--format toon|md|json]` | Score the change from repository history and apply the hard rules. With --intent it also measures intent-versus-diff drift and scores it as S7. A hard-rule hit parks the run as `must_read` until `axi respond` answers it. Exits 0 whatever the band is, unless --strict is passed. |
| `eyes-on why <file> | eyes-on why --top <n>` | Explain where the risk of this file came from: the fix commits that blamed into it, the commits that touched it, and any hard rule naming it. With --top and no file, list the riskiest code files in the repository instead. |
| `eyes-on rules --check [--strict]` | Evaluate the hard rules alone, without scoring. Rules are read from the default branch at a pinned commit, so a branch that deletes one still gets it. |
| `eyes-on export-path-instructions [--min-risk <0-100>]` | Emit a review.path_instructions block for .no-mistakes.yaml, inside its 32-entry and 16384-byte caps. A bridge, never a dependency. |
| `eyes-on backtest --split <date>[,<date>...] [--horizon <days>]` | Replay the risk signal against history either side of a split date and report how much more often the flagged files were fixed afterwards. |
| `eyes-on spotlight [--base <ref>] [--head <ref>] [--n 5] [--intent "..."] [--no-model]` | Rank the three to five fragments a human should actually read. Two stages: arithmetic over git narrows the diff to twelve candidates, then one model call picks a few and says why. --no-model returns stage one and calls nothing. |
| `eyes-on drift [--base <ref>] [--head <ref>] [--intent "..."] [--no-model]` | Compare the stated intent with what the diff actually does, in two passes: one model describes the diff without seeing the intent, a second compares that description with it. The grade is folded into the recorded check as signal S7, so the score, its maximum and the band move with it. This command itself is never a gate. |
| `eyes-on comment --pr <n> [--dry-run]` | Publish the single sticky eyes-on comment on a pull request, found by its marker and updated in place. Never touches the body, never merges, never files a review. |

## Commands that are planned but not built yet

Calling one of these prints `error:` with the stage that owns it and exits 1. It never returns a made-up answer.

| Command | Stage | What it will do |
|---|---|---|
| `eyes-on label --pr <n>` | stage 3 | Record the channel, the decision and the merge commit in the ledger after a merge. |
| `eyes-on leaks [--window 14d] [--since 90d]` | stage 3 | Report post-merge fixes per channel - the line-level variant only. |
| `eyes-on calibrate` | stage 3 | Propose thresholds from the ledger by sweeping them over recorded history. |

## The order these commands go in

```sh
eyes-on check --intent "why this change was made, not what it changes"
eyes-on spotlight              # the three to five fragments to read
eyes-on comment --pr 42        # one sticky comment on the pull request
```

`check` scores the change and, with an intent, measures how far the diff has drifted from it. `spotlight`
ranks fragments in two stages: arithmetic over the repository's history narrows the diff to twelve
candidates, and one model call picks three to five and says why. `--no-model` returns the first stage
alone and calls no model at all - use it when the model is rate-limited, and read the `stage` field to
see which answer you got.

## When a hard rule parks the run

A hard rule matching sets the band to `pelna` and parks the check as `must_read`. Answer it:

```sh
eyes-on axi respond --action read
eyes-on axi respond --action waive --reason "why this is safe to merge unread"
```

A waiver without a reason is refused. **The park holds nothing up outside eyes-on** - no exit code
changes, no push waits, no pull request goes red. What it does is record that somebody was told and what
they decided, so the channel label is evidence rather than a declaration.

## Output contract

- Machine-readable payload on **stdout**, TOON by default. Pass `--format json` for JSON or `--format md` for Markdown.
- Progress and diagnostics on **stderr**. Never parse stderr.
- Exit codes: `0` success or no-op, `1` error, `2` usage error.
- Every failure carries `error:` and `help:`. Read `help:` before retrying - it names the next step.

## Working with no-mistakes

Both tools read the same working clone and nothing else is shared. eyes-on never writes to
`~/.no-mistakes`, never creates a ref in your clone, and never touches a pull request body: the body is
no-mistakes' and is regenerated on every update, so eyes-on publishes a single comment carrying a marker
and updates that same comment however many times it is recomputed. It never merges and never files a
GitHub review.

Called from inside a no-mistakes pipeline step - `NO_MISTAKES_GATE=1`, or a working directory under the
no-mistakes worktree root - eyes-on refuses to record anything and says so. That is deliberate: the work
a pipeline step is holding is still being rewritten, so an assessment of it would be an assessment of
nothing. Read-only commands keep working there.

The useful order is: assess with eyes-on first, then run `/no-mistakes` to validate and ship.

## Getting started in a repository

```sh
eyes-on init          # register the repository, build the mirror, start the daemon
eyes-on doctor        # what is available and what is degraded
eyes-on status        # daemon and registered repositories
```

`eyes-on init` is idempotent: run it again to repair a missing mirror, a stopped daemon or a stale skill.
