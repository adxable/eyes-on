# Stage 0 acceptance

Measured on 1 September 2026 against commit `3cfa36a` - the final stage 0 code,
after every review fix - on macOS 25.2.0, Node v22.21.1, git 2.39.5, gh 2.82.0.

The reference clone is `~/Projects/firstmate/projects/adx-worker` (91.7 MB
`.git`, 369 refs) and it was read only: no ref, hook, remote or config entry in
it was written at any point.

The session ran against a temporary state root `~/.eyes-on-acceptance` with the
**real** service manager, so the coexistence result is a launchd measurement
rather than a simulation. Afterwards the state root, the LaunchAgent and the
daemon were all removed; nothing from this session persists on the machine.

Five of the six results have an automated counterpart that runs on every
`npm test`: foreign state untouched (2), clone untouched (3), mirror cost (4)
and recursion refusal (5) in `test/coexistence.test.ts`, and idempotency (6) in
`test/cli.test.ts`. **Daemon coexistence (1) has no automated counterpart** - it
needs a live no-mistakes install and a real service manager - so it exists only
as the manual measurement recorded below. `test/coexistence.test.ts` also
carries the clone allow-list rules, which are not rows in the table.

At the measured commit: 101 tests pass, `npm run typecheck` and `npm run lint`
are clean.

## Results

| Test | Criterion | Result |
|---|---|---|
| Daemon coexistence | both daemons live at once; `no-mistakes axi` and `doctor` answer as before | **pass** - two live pids, both outputs byte-identical |
| Foreign state untouched | `find ~/.no-mistakes -newer <marker>` is empty | **pass** - 0 entries |
| Clone untouched | `git status --porcelain` and `for-each-ref` identical before and after | **pass** - identical |
| Mirror cost | create < 1 s, size < 5 MB, incremental fetch < 0.5 s | **pass** - 0.356 s, 272 KB, 0.066 s |
| Recursion refusal | `NO_MISTAKES_GATE=1 eyes-on check` refuses; `eyes-on status` works | **pass** - exit 2 / exit 0 |
| Idempotency | a second `init` duplicates nothing and repairs what is missing | **pass** - daemon pid unchanged, nothing duplicated |

A seventh property was added while stage 0 was being reviewed, because a fix
briefly broke it: `init` on a host with no usable service manager must still end
with a live daemon. It is measured in section 7.

## 1. Daemon coexistence

```
$ launchctl list | grep -E 'no-mistakes|eyes-on'
1255     0  com.kunchenguid.no-mistakes.daemon.733b4626
48412    0  com.adxable.eyes-on.daemon.af804f2b
```

Two live processes, two labels, two root hashes. The labels cannot collide: both
tools scope the label by a hash of their own state root, and eyes-on also
carries a different prefix. The eyes-on daemon here is the one launchd started -
`init` adopted the managed job rather than spawning beside it.

`no-mistakes axi` and `no-mistakes doctor` were captured before the install and
again after the full session. Both were **byte-identical** to the baseline
(`diff` reported no difference), and the no-mistakes daemon kept pid 1255
throughout: it was never signalled, reloaded or restarted.

## 2. Foreign state untouched

A marker file was stamped after the baseline no-mistakes calls and before any
eyes-on command. The session then ran `init`, a second `init`, `init --force`,
`doctor`, `status`, `daemon status`, the recursion checks and the hook
measurement.

```
$ find ~/.no-mistakes -newer <marker> | wc -l
0
```

Still 0 after the teardown that removed the LaunchAgent, the daemon and the
state root.

One caveat, stated so the result can be reproduced rather than taken on trust:
re-running `no-mistakes axi` and `no-mistakes doctor` afterwards - for the
comparison in section 1 - does make `find` report
`~/.no-mistakes/telemetry-gate.json`. That file is written by no-mistakes
itself, by its own read-surface telemetry gate, during those two invocations.
The measurement above was taken before them, which is the only ordering under
which the check means anything.

The measurement above exercises the ordinary case, where the two roots are
separate. The case it cannot reach is a state root *inside* the foreign one -
`EYES_HOME=~/.no-mistakes/eyes-on` - because that root is refused rather than
used: `Paths` compares the physical path of the resolved root against `NM_HOME`
at any depth and every command fails with `error:` plus a `help:` line naming
`EYES_HOME`, before the root is created. `test/coexistence.test.ts` asserts the
refusal by inventorying the foreign root before and after and requiring the two
listings to be equal, so what is proven is that nothing was written rather than
that something was reported.

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
stays at zero; the hook is measured separately in section 8.

Every clone read goes through `gitReadClone`, which checks the subcommand
against an allow-list and additionally refuses the write forms of `config`,
`remote` and `symbolic-ref`. The mirror fetch reads the clone through
`upload-pack` and writes only into the mirror. Both properties are asserted in
`test/coexistence.test.ts` on every `npm test`.

## 4. Mirror cost

```
$ rm -rf <root>/mirrors/*.git && eyes-on init --force
full init wall clock  0.356 s        (criterion < 1 s)
  of which fetch      0.068 s
mirror size           31,909 bytes apparent / 272 KB on disk   (criterion < 5 MB)
refs fetched          46
$ eyes-on init            # incremental, nothing new
incremental fetch     0.066 s        (criterion < 0.5 s)
```

For scale: the clone's own `.git` is 91.7 MB, and the scope report measured a
full `git clone --bare --no-hardlinks` at 87 MB and 2.13 s. The mirror is 272 KB
because it borrows objects through `objects/info/alternates` instead of copying
them - matching that report's reference measurement exactly.

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
$ NO_MISTAKES_GATE=1 eyes-on status   -> exit 0   (read-only; reports inside_no_mistakes_run: true)
$ NO_MISTAKES_GATE=1 eyes-on doctor   -> exit 0   (read-only, works)
```

The refusal is driven by the command registry's `mutating` flag, so it applies
to every command that records anything - including the stage 1+ commands that
are not implemented yet. A working directory under `<NM_HOME>/worktrees` is
detected the same way, whatever the environment says.

## 6. Idempotency

A second `init` on an already-registered repository:

| Property | First run | Second run |
|---|---|---|
| `repo_id` | `95f7e5ed29dc` | identical |
| mirror path | `mirrors/95f7e5ed29dc.git` | identical |
| service label | `com.adxable.eyes-on.daemon.af804f2b` | identical |
| `mirror_created` | true | **false** |
| `config_written` | true | **false** |
| daemon | adopted from launchd, pid 48412 | **already running, pid 48412** |
| incremental fetch | - | 68 ms |

After both runs: 1 repository row, 1 mirror directory, 1 LaunchAgent plist. The
daemon pid is unchanged, so a repeat `init` does not bounce a healthy daemon -
an unchanged, already-loaded service is left strictly alone.

Repair is covered separately by `test/cli.test.ts`, "init repairs what is
missing on the second run": with the mirror deleted and the daemon stopped, the
second `init` reports `mirror_created: true` and `daemon: started` and restores
both.

## 7. init without a usable service manager

Added as an acceptance condition during review, after a fix made `init` fail
outright with no daemon at all on hosts where the unit file can be written but
the job can never be loaded - Linux with no systemd user bus, which covers
Docker, most CI runners, default WSL and sysvinit.

```
$ EYES_HOME=<temp> EYES_ON_SKIP_SERVICE_MANAGER=1 eyes-on init
daemon: started   pid 52879
service: not installed
$ eyes-on daemon status
running, pid 52879
```

One startup path, with a fallback that actually falls back: where a service
manager holds the job, `init` and `daemon start|restart` address that job; where
none does, the daemon is spawned directly.

## 8. The optional post-commit hook

Measured on a throwaway repository, five commits each way:

| | `git commit` wall clock |
|---|---|
| no hook | 26, 26, 26, 59, 23 ms |
| eyes-on hook | 773, 30, 28, 28, 28 ms |

The first figure with the hook is a cold Node start; the settled overhead is
**about +3 ms**, comfortably inside the scope report's +10 ms reference. All
five notifications reached the daemon (five `commit.observed` records with the
matching repo id).

The generated hook carries the registered state root explicitly
(`daemon notify-commit --root <root>`), so an install under a non-default
`EYES_HOME` notifies its own daemon rather than silently talking to `~/.eyes-on`.

A foreign `post-commit` hook present beforehand is moved to
`post-commit.eyes-on-user` and still runs after ours, and a deliberately failing
user hook does not fail the commit (`test/hook.test.ts`).

## Known limitation, deferred to a separate task

Daemon startup under a service manager went through several review rounds. The
orphan split - a managed job loaded with no process while an unmanaged daemon
serves the root - is closed for the paths the acceptance conditions cover, but
the review's last pass raised further edge cases that were deliberately not
pursued in stage 0: `init` does not wait for the daemon to stop when it
uninstalls a service, a `launchctl bootout` failure is not inspected, a
`kickstart` without `-k` is a no-op against a job launchd still considers
running, and the wiring between `installService` and `init` is covered less
thoroughly than the decision table it feeds. None of them affects any of the six
acceptance conditions, and all of them concern behaviour after a manual edit of
`config.yaml` or a race between two concurrent invocations.

## Not run

- **Windows.** The service integration covers launchd and systemd; on any other
  platform `init` reports that no service manager is available and the daemon
  runs unmanaged. No Windows machine was available to test against.
- **Linux systemd.** The systemd path is exercised by unit tests over the
  generated unit file, not by a live `systemctl` session; no Linux host was
  available. The no-service-manager fallback in section 7 was measured on macOS
  with the service manager bypassed, which is the same code path a host without
  a usable manager takes.
- **A second concurrent no-mistakes install.** Coexistence was measured against
  the one live no-mistakes daemon on this machine, not against several roots.
- **`gh`-dependent behaviour.** Nothing at stage 0 calls `gh` beyond `doctor`
  probing for it and reporting whether it is authenticated.
- **CI.** The repository has no CI checks; `adxable/eyes-on` declares
  `no_ci: true` on its default branch. GitHub Actions does not start on this
  account, so every gate that matters runs locally in the pipeline.
