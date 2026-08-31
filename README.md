# eyes-on

A local daemon that computes, from a repository's own history, **whether and what
a human must read** in a change before it is merged, records that decision as a
durable record, and after the merge checks whether the decision was right.

It runs beside no-mistakes and never modifies it. no-mistakes is responsible for
the code being good; eyes-on is responsible for a human reading the part that
matters, and for making it possible to check afterwards whether the threshold
was set correctly.

## Status: stage 0

Stage 0 is the skeleton every later feature stands on: the state root, the
daemon, the mirror, the command surface and the agent skill. **Risk scoring is
not implemented yet.** Commands that compute risk are listed, documented, and
report the stage that will deliver them - they never return a made-up answer.

See [docs/stage-0-acceptance.md](docs/stage-0-acceptance.md) for the measured
acceptance results.

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
| `eyes-on daemon {start\|stop\|restart\|status\|run --root <dir>}` | Manage the daemon |
| `eyes-on axi status` | The agent surface |

`eyes-on check`, `why`, `rules`, `spotlight`, `drift`, `comment`, `label`,
`leaks`, `calibrate` and `backtest` arrive in stages 1 to 3.

## Output contract

- Machine payload on **stdout**, TOON by default; `--format json|md` to change it.
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
