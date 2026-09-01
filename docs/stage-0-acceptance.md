# Stage 0 acceptance

Measured on 31 August 2026, macOS 25.2.0, Node v22.21.1, git 2.39.5, gh 2.82.0.

The reference clone is `~/Projects/firstmate/projects/adx-worker` (91.7 MB `.git`,
369 refs) and it was read only: no ref, hook, remote or config entry in it was
written at any point.

The session ran against a temporary state root `~/.eyes-on-acceptance` with the
**real** service manager, so the coexistence result is a launchd measurement
rather than a simulation. The root and its LaunchAgent were removed afterwards;
nothing from this run persists on the machine.

Four of the six results below have an automated counterpart in
`test/coexistence.test.ts`, which runs them against throwaway repositories on
every `npm test`: foreign state untouched (2), clone untouched (3), mirror cost
(4) and recursion refusal (5). That file also carries the K2 clone allow-list
rule, which is not a row in the table. Idempotency (6) is automated in
`test/cli.test.ts`. **Daemon coexistence (1) has no automated counterpart** -
it needs a live no-mistakes install and a real service manager, so it was
measured by hand and the numbers below are that measurement.

## What these numbers were measured against

The session above ran on commit `dbc1b52`. Every review-fix commit since -
`f01ca51`, `435e0e7`, `f363f06`, `5ed536a`, `ef16f1a`, `2c3ceca` and `dda0740` -
changed code, and each change belongs to a different result (`ee62180` touched
tests only):

- **Results 1 and 6 (daemon coexistence, idempotency).** The service
  install/reload decision became a semantic comparison with a separate
  byte-write and then stopped deciding process lifecycle at all; starting the
  daemon moved behind a single path that addresses the managed job instead of
  spawning beside it, with the direct spawn kept for hosts where no service
  manager holds anything; `init` became the single owner of whether a root has a
  managed service, removing the job when `daemon.managed_service` is off instead
  of leaving one loaded for the next `daemon start` to revive; and `doctor` now
  reads LaunchAgent labels through `plutil -lint` plus `-extract`.
- **Result 3 (clone untouched).** Every clone read moved behind `gitReadClone`,
  which now also refuses the write forms of `config`, `remote` and
  `symbolic-ref`. This one is *strengthened* rather than made stale: its
  automated counterpart in `test/coexistence.test.ts` runs against the current
  code on every `npm test`, and the recorded numbers still describe what a
  session does to a clone - nothing.

So, plainly: **daemon coexistence (1) and idempotency (6) are pre-fix
measurements, pending re-measurement against the final code.** They are stale to
different degrees, and the difference matters:

- **Daemon coexistence (1) has no automated counterpart at all** (as stated
  above), so nothing covers it against the current code. It is stale in full.
- **Idempotency (6)** has one - `test/cli.test.ts`, "init repairs what is
  missing on the second run" - which does run against the current code, so the
  property is covered even though the recorded launchd numbers are not.

Results 2, 3, 4 and 5 stand as recorded; their automated counterparts in
`test/coexistence.test.ts` run against the current code. The K2 clone allow-list
rule in that file is not a counterpart to any of the six results - it is not a
row in the table.

All six will be re-run against the final code before delivery and this document
replaced with the refreshed numbers.

## Results

| Test | Criterion | Result |
|---|---|---|
| Daemon coexistence | both daemons live at once; `no-mistakes axi` and `doctor` answer as before | **pass** (measured pre-fix, see above) |
| Foreign state untouched | `find ~/.no-mistakes -newer <marker>` is empty | **pass** - 0 entries |
| Clone untouched | `git status --porcelain` and `for-each-ref` identical before and after | **pass** - identical |
| Mirror cost | create < 1 s, size < 5 MB, incremental fetch < 0.5 s | **pass** - 0.367 s, 272 KB, 0.070 s |
| Recursion refusal | `NO_MISTAKES_GATE=1 eyes-on check` refuses; `eyes-on status` works | **pass** - exit 2 / exit 0 |
| Idempotency | a second `init` duplicates nothing and repairs what is missing | **pass** (measured pre-fix, see above) |

## 1. Daemon coexistence

Measured on `dbc1b52`, before the review fixes; pending re-measurement, and with
no automated counterpart to stand in for it in the meantime.

```
$ launchctl list | grep -E 'no-mistakes|eyes-on'
1255     0  com.kunchenguid.no-mistakes.daemon.733b4626
33467    0  com.adxable.eyes-on.daemon.af804f2b
```

Two live processes, two labels, two root hashes. The labels cannot collide:
both tools scope the label by a hash of their own state root, and eyes-on also
carries a different prefix.

`no-mistakes axi` and `no-mistakes doctor` were captured before the install and
again after the full session. Both were **byte-identical** to the baseline
(`diff` reported no difference), and the no-mistakes daemon kept pid 1255
throughout - it was never signalled, reloaded or restarted.

## 2. Foreign state untouched

A marker file was stamped after the baseline no-mistakes calls and before any
eyes-on command. The session then ran `init`, `doctor`, `status`,
`daemon status`, `init --force`, a second `init`, and the recursion checks.

```
$ find ~/.no-mistakes -newer <marker> | wc -l
0
```

Empty, including after the teardown that removed the LaunchAgent and the state
root.

One caveat, stated so the result can be reproduced rather than taken on trust:
re-running `no-mistakes axi` and `no-mistakes doctor` afterwards - for the
comparison in section 1 - does make `find` report
`~/.no-mistakes/telemetry-gate.json`. That file is written by no-mistakes
itself, by its own read-surface telemetry gate, during those two invocations.
The measurement above was taken before them, which is the only ordering under
which the check means anything.

## 3. Clone untouched

Captured on adx-worker immediately before and after the session:

| Probe | Before | After |
|---|---|---|
| `git status --porcelain` | 0 lines | identical |
| `git for-each-ref` | 369 lines | identical |
| `git remote -v` | 4 lines | identical |
| `git config --local --list` | 18 lines | identical |
| non-sample hooks in `.git/hooks` | 0 | 0 |

The mirror is fetched *into*, never pushed *from*, so no ref in the clone moves.
`--watch` was deliberately not used on adx-worker, which is why its hook count
stays at zero; the hook is measured separately in section 7.

## 4. Mirror cost

```
$ rm -rf <root>/mirrors/95f7e5ed29dc.git && eyes-on init --force
full init wall clock  0.367 s        (criterion < 1 s)
  of which fetch      0.077 s
mirror size           31,909 bytes apparent / 272 KB on disk   (criterion < 5 MB)
refs fetched          46
$ eyes-on init            # incremental, nothing new
incremental fetch     0.070 s        (criterion < 0.5 s)
```

For scale: the clone's own `.git` is 91.7 MB, and the report measured a full
`git clone --bare --no-hardlinks` at 87 MB and 2.13 s. The mirror is 272 KB
because it borrows objects through `objects/info/alternates` instead of copying
them - matching the report's reference measurement exactly.

Two size numbers are quoted because they measure different things: 31,909 bytes
is the sum of apparent file sizes, 272 KB is `du` counting 4 KB allocation
blocks across many small ref files. Both are far under the budget.

## 5. Recursion refusal

```
$ NO_MISTAKES_GATE=1 eyes-on check
error: refusing to run "check" from inside a no-mistakes run: NO_MISTAKES_GATE=1 is set, ...
help: eyes-on check mutates eyes-on state, and eyes-on refuses to do that from inside a no-mistakes run
help: Run it from your working clone after the pipeline finishes, not from a pipeline step
help: Read-only commands still work here: `eyes-on status`, `eyes-on doctor`, `eyes-on daemon status`
exit 2

$ NO_MISTAKES_GATE=1 eyes-on init     -> exit 2   (mutating, refused)
$ NO_MISTAKES_GATE=1 eyes-on status   -> exit 0   (read-only, works; reports inside_no_mistakes_run: true)
$ NO_MISTAKES_GATE=1 eyes-on doctor   -> exit 0   (read-only, works)
```

The refusal is driven by the command registry's `mutating` flag, so it applies
to every command that records anything - including the stage 1+ commands that
are not implemented yet. A working directory under `<NM_HOME>/worktrees` is
detected the same way, whatever the environment says.

## 6. Idempotency

Measured on `dbc1b52`, before the review fixes; pending re-measurement. The
reload decision has since become semantic, and starting the daemon now goes
through one path that addresses the managed job instead of spawning beside it,
so the repair path below is not the one the current code takes.

A second `init` on an already-registered repository:

| Property | First run | Second run |
|---|---|---|
| `repo_id` | `95f7e5ed29dc` | identical |
| mirror path | `mirrors/95f7e5ed29dc.git` | identical |
| `mirror_created` | true | **false** |
| `config_written` | true | **false** |
| daemon | started by launchd, pid 33467 | **already running, pid 33467** |
| service label | `com.adxable.eyes-on.daemon.af804f2b` | identical |

After both runs: 1 repository row, 1 mirror directory, 1 LaunchAgent plist. The
daemon pid is unchanged, so a repeat `init` does not bounce a healthy daemon.

Repair was verified separately by deleting the mirror and stopping the daemon
before re-running: the second `init` reported `mirror_created: true` and
`daemon: started`, restoring both (`test/cli.test.ts`, "init repairs what is
missing on the second run").

## 7. The optional post-commit hook

Measured on a throwaway repository, five commits each way:

| | `git commit` wall clock |
|---|---|
| no hook | 27, 27, 28, 27, 28 ms |
| eyes-on hook | 640, 32, 31, 32, 36 ms |

The first figure is a cold Node start; the settled overhead is **about +5 ms**,
consistent with the report's +10 ms reference. All five notifications reached
the daemon (five `commit.observed` records with the matching repo id).

A foreign `post-commit` hook present beforehand was moved to
`post-commit.eyes-on-user` and still ran after ours, and a deliberately failing
user hook did not fail the commit (`test/hook.test.ts`).

## Not run

- **Windows.** The service integration covers launchd and systemd; on any other
  platform `init` reports that no service manager is available and the daemon
  runs unmanaged. No Windows machine was available to test against.
- **A second concurrent no-mistakes install.** Coexistence was measured against
  the one live no-mistakes daemon on this machine, not against several roots.
- **`gh`-dependent behaviour.** Nothing at stage 0 calls `gh` beyond `doctor`
  probing for it and reporting whether it is authenticated.
