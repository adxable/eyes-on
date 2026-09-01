# Stage 1 acceptance

Stage 1 delivers the product's reason for existing: a risk score computed from
repository history, and hard rules on sensitive paths that statistics do not get
a vote on. This document records what was measured, what passed, and the one
condition that did not.

As in stage 0, the evidence comes in two kinds and they age differently.

**Four of the seven conditions have automated counterparts** that run on every
`npm test` against whatever the code currently is. Those tests, not the figures
below, are the standing evidence for them:

| Condition | Test |
|---|---|
| Noise filter | `acceptance: no .md or .jsonl file appears in the risk ranking`, in `test/check.test.ts` |
| Rules are trusted | `acceptance: a branch that deletes the rule still gets the rule` and the three tests beside it, in `test/rules.test.ts` |
| Non-blocking | `acceptance: a hard-rule hit sets the band to pelna and still exits 0` (`test/check.test.ts`) and `acceptance: a hard-rule hit exits 0, and only --strict changes that` (`test/rules.test.ts`) |
| Export cap | `an export of any size stays inside both of no-mistakes' caps`, in `test/export.test.ts` |

**The remaining three - fix-history discrimination, churn discrimination and
cost - have no automated counterpart**, because they are statements about one
particular repository with 271 commits of real history. They were measured in
one session described below.

One further test covers the *mechanism* rather than any condition, and is
listed separately so it cannot be read as evidence for the figures:

| Not one of the seven | Test |
|---|---|
| Backtest mechanism | `the signal separates the files that went on to be fixed from the ones that did not` and `a repository where nothing predicts anything reports a lift of about one, not a pass`, in `test/backtest.test.ts` - they prove `backtest` computes and reports a lift on synthetic repositories built by the suite. The adx-worker lift figures below are a one-off measurement on one repository and no test asserts them. |

## The measured session

Measured on **1 September 2026** against the eyes-on branch head at the time
this document was written - the head of the stage 1 pull request as it was
merged - on macOS 25.2.0, Node v22.21.1, git 2.39.5.

The reference repository is `~/Projects/firstmate/projects/adx-worker`, read
only: 271 commits between 10 July and 26 August 2026, 956 code files by the
shipped `include` patterns, 369 refs. Nothing in it was written at any point,
and the section "The clone was not touched" below is the check rather than the
claim.

The session ran against a temporary state root under the session scratch
directory, with `EYES_ON_SKIP_SERVICE_MANAGER=1` so no LaunchAgent was
registered, and the daemon it started was stopped afterwards. Nothing from the
session persists on the machine.

Deliberately **not** anchored to a commit identifier: a stage 0 lesson repaid in
this task is that a SHA taken from a pull-request branch does not survive the
squash-merge that lands it, so it names nothing a week later. See the note at the
top of `docs/stage-0-acceptance.md`.

## Results

| Test | Criterion | Result |
|---|---|---|
| Fix-history discrimination | on four split dates, files with a fix history are fixed ≥ 2.5x more often afterwards than the average file | **partial** - 3.38x / 2.16x / 2.86x / 3.10x: three of four splits clear it, one does not |
| Churn discrimination | top decile ≥ 3x over the average | **pass** - 3.46x / 3.81x / 6.03x / 6.96x |
| Cost | full recomputation < 30 s, incremental < 2 s | **pass** - 16.5 s and 0.99-1.05 s |
| Noise filter | no `.md` or `.jsonl` file in the ten riskiest | **pass** - 0 of 10, against `AGENTS.md` at #1 without the filter |
| Rules are trusted | a branch deleting a rule from `.eyes-on.yml` still gets it | **pass** |
| Non-blocking | exit 0 on a hard-rule hit without `--strict` | **pass** |
| Export cap | inside 32 entries and 16384 bytes | **pass** - 27 entries, 16001 bytes |

## 1. Discrimination

`eyes-on backtest --split 2026-07-20,2026-07-27,2026-08-03,2026-08-10`, anchored
at `refs/remotes/origin/main`. The signal is computed only from commits before
each split, the outcome only from commits after it, and the population is the
code files that existed at the split - a file created afterwards could never
have been flagged, and leaving it in the denominator would flatter every signal.

| split | code files | blamed by a fix | lift | touched by a fix | lift | churn top decile | lift |
|---|---|---|---|---|---|---|---|
| 2026-07-20 | 410 | 7 | **3.38x** | 9 | 2.63x | 41 | **3.46x** |
| 2026-07-27 | 619 | 43 | **2.16x** | 73 | 2.54x | 61 | **3.81x** |
| 2026-08-03 | 744 | 78 | **2.86x** | 120 | 4.03x | 74 | **6.03x** |
| 2026-08-10 | 835 | 83 | **3.10x** | 129 | 3.98x | 83 | **6.96x** |

**Churn passes with room to spare** and lands close to the report's reference
figures (3.7x / 5.8x / 6.5x / 6.3x), which is the strongest evidence that the
population and outcome definitions here match the ones behind those references.

**Fix history does not clear 2.5x on every split.** Three of the four do; the
2026-07-27 split reaches 2.16x. The mean over the four is 2.88x. The report's
reference figures are 4.2x / 3.8x / 3.6x / 2.9x, so the shortfall is real and
not a rounding difference.

**The 2.5x threshold itself is provisional.** It was set from an earlier and
looser measurement whose method is not recorded, and the measurement here uses a
denominator that measurement may not have: the population is the code files that
*existed at the split*, because a file created afterwards could never have been
flagged and counting it would flatter every signal. Lower numbers under a
stricter denominator are not the same thing as a weaker signal. The threshold
waits on confirmation from a longer history than this repository's seven weeks;
`calibrate` in stage 3 is where it stops being a number somebody chose.

The partial result is accepted as delivered rather than tuned away
(`~/Projects/firstmate/data/eyes-on-etap1-mvp/decyzja-prog-25.md`): fitting the
signal to a threshold on one repository with seven weeks of history is tuning to
the measurement, which is the failure the research report warns about directly.

Two things are worth stating about it rather than explaining it away.

**It is not caused by renames.** The obvious suspect - a hot file renamed after
the split, so its later fixes land on a path the flagged set never saw - was
measured and is not present: of the population at each split, **zero** files were
renamed away afterwards.

**A weaker flag does better here, and the command now says so.** Flagging a file
because a fix commit merely *touched* it, with no blame step, clears 2.5x on all
four splits (2.63x / 2.54x / 4.03x / 3.98x). That is the cheapest possible
version of the signal, and on this repository, at these sample sizes, it
discriminates at least as well as the blame-based one. `backtest` reports both,
side by side, for exactly that reason: the blame step costs the bulk of the
16.5 s full recomputation, and it has to earn that cost against a free
alternative. Stage 3's `calibrate` is where that comparison turns into a
decision; stage 1 only makes it visible.

Three cautions on the numbers themselves, so they are not read as stronger than
they are:

- the repository's whole history is seven weeks, so the earliest split has one
  fix commit behind it and the latest has two weeks of outcome ahead of it;
- the base rates are small (0.02 to 0.13 post-split fix touches per file), so
  these lifts are ratios of small numbers;
- a fixed outcome horizon was tried (14 and 21 days) to make the four splits
  comparable, and made the 2026-07-27 result worse rather than better (1.49x),
  so the unbounded window reported above is both the simpler and the more
  favourable choice. It is stated here so nobody has to wonder whether a horizon
  was quietly chosen to pass.

## 2. Cost

```
$ eyes-on check                          # empty blame cache
real 16.51 s     (criterion < 30 s)
  249 commits walked, 28 fix commits blamed, 0 from cache
  53 changed files, 48 of them code, score 93, band pelna

$ eyes-on check                          # three consecutive runs, warm cache
real 1.05 s / 1.00 s / 0.99 s            (criterion < 2 s)
  28 fix commits, all 28 from cache, 0 blamed
```

The scope report's reference for the same work is 12.7 s over 271 commits; 16.5 s
here covers 249 commits inside the 90-day window plus the diff, the ranking and
the report write. The incremental figure is what the cache buys: the whole blame
step disappears, and what remains is a `git log --numstat` walk and Node's own
start-up. Of the 1.0 s, the assessment itself reports 0.69 s.

## 3. Noise filter

```
$ eyes-on why --top 10
```

| # | file | risk | fixes | churn |
|---|---|---|---|---|
| 1 | `packages/channels/src/handler.ts` | 94 | 4 | 35 |
| 2 | `packages/worker-runtime/src/vm/mail-loop.ts` | 94 | 4 | 25 |
| 3 | `packages/operator-cli/bin/provision-scaleway.ts` | 91 | 6 | 12 |
| 4 | `packages/provisioning/src/scaleway/provision-scaleway.ts` | 79 | 5 | 7 |
| 5 | `packages/worker-runtime/src/vm/agent.ts` | 78 | 2 | 36 |
| 6 | `packages/worker-runtime/src/ingress/panel-serve.ts` | 78 | 2 | 27 |
| 7 | `packages/worker-runtime/src/vm/chat-loop.ts` | 76 | 2 | 16 |
| 8 | `packages/provisioning/src/scaleway/cloud-init.ts` | 73 | 3 | 7 |
| 9 | `packages/channels/src/notify.ts` | 69 | 2 | 9 |
| 10 | `packages/operator-cli/bin/provision-hetzner.ts` | 66 | 2 | 8 |

Zero `.md` and zero `.jsonl`. The counterfactual is what makes that mean
something: the same ranking with `include: ["**/*"]` and no `exclude` puts

| 1 | `AGENTS.md` | 99 | 17 fixes | 169 commits |
| 4 | `docs/migration/scaleway-phase1.md` | 92 | 5 | 13 |
| 6 | `packages/worker-runtime/src/vm/panel-app-assets.generated.ts` | 81 | 3 | 12 |

at the top - reproducing the report's measured claim that `AGENTS.md` is
otherwise number one, and adding a generated file at number six. Neither is a
place to send a reviewer.

## 4. The clone was not touched

Captured on adx-worker immediately before the session and again after it, with
a marker file stamped between them:

| Probe | Before | After |
|---|---|---|
| `git status --porcelain` | 0 lines | identical |
| `git for-each-ref` | 369 lines | identical |
| `git config --local --list` | 18 lines | identical |
| `git remote -v` | 4 lines | identical |
| non-sample hooks in `.git/hooks` | 0 | 0 |

```
$ find ~/.no-mistakes -newer <marker> | wc -l
0
```

The same caveat as stage 0 applies and is worth repeating because it was
observed again in this session: `~/.no-mistakes/telemetry-gate.json` does get
written while eyes-on runs, by **no-mistakes itself**, whenever any lane on this
machine invokes `no-mistakes axi`. Its contents are no-mistakes' own run
fingerprints for other branches. The measurement above was taken over a window
containing only eyes-on commands, which is the only ordering under which it means
anything.

The mirror is 272 KB against the clone's 91.7 MB `.git`, because it borrows
objects through `objects/info/alternates` rather than copying them.

## 5. Rules are trusted, and nothing blocks

Both are asserted on every `npm test`, against real repositories built by the
suite:

- a branch that deletes `.eyes-on.yml` entirely **and** changes the path its
  deleted rule protected still gets the rule, with `config_state: trusted` and
  the rule read from `refs/heads/main` at a pinned commit;
- a branch that invents a rule does not get it: the default branch has no
  configuration, so there is nothing to trust;
- a trusted copy that exists and cannot be parsed is `unverified`, carrying the
  parse error and the sentence "no hard rule was evaluated" - never a silent
  empty rule set;
- a hard-rule hit sets the band to `pelna` while the process exits 0. Only
  `--strict` produces a non-zero exit, and it is the only thing that does.

## 6. Export cap

```
$ eyes-on export-path-instructions
27 entries of at most 32, 16001 bytes of at most 16384
3 candidates dropped (byte-cap): packages/connections/test/**,
                                 packages/operator-cli/src/**,
                                 packages/security/src/**
```

The caps and the byte accounting are no-mistakes' own
(`ReviewPathInstructionsBytes` in `internal/config/config.go`), reimplemented
rather than imported, because this is a bridge and not a dependency. What falls
off the end is named in the output rather than silently truncated: a cap nobody
is told about reads as coverage.

## What this session found, beyond the conditions

A defect in stage 0 code, discovered because it silently corrupted an early
measurement: `eyes-on init` under one state root registered the repository into
a **different** root's database and mirror, while reporting the root it had been
given. A unix socket address is a fixed-size kernel field - 104 bytes on macOS -
and an address past it is truncated rather than refused, so two deep scratch
roots sharing their first 104 bytes bound and connected to one address. Fixed in
this branch: a root whose `<root>/socket` would not fit gets a short address
derived from a hash of the canonical root, in a per-user directory created 0700
rather than loose in the shared temporary directory, and `doctor` reports the
relocation.
The default root is nowhere near the limit, so no ordinary installation was
affected.

## Not measured

- **The drift signal (S7).** It is weighted 0.00 at this stage by the report's
  own schedule and lands in stage 2. It is present in the output with a weight
  of zero rather than absent, so a reader can see which signal is not yet scored.
- **Band distribution over many changes.** The thresholds 35 and 65 are the
  report's and were not re-derived here; `calibrate` (stage 3) is where they are
  argued from the ledger rather than from a single change.
- **Repositories other than adx-worker and the suite's own fixtures.** Every
  figure above is one repository's, with one author and seven weeks of history.
- **Windows and Linux.** As in stage 0, the session was macOS only.
