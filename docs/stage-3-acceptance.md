# Stage 3 acceptance

Stage 1 says *whether* a human has to read a change. Stage 2 says *what*. Stage
3 is the part that says whether either of those thresholds is set right, and
without it the first two are a guess with a good interface.

It delivers three commands. `label` appends one line to `ledger.jsonl` for a
merged change, carrying the channel it merged under and the commit that landed
it. `leaks` reports, per channel, how often a registered merge was followed by a
fix commit whose blame names it. `calibrate` sweeps a grid of thresholds over
that register and reports what each pair would have caught and what it would
have let through.

As in stages 0 to 2, the evidence comes in two kinds and they age differently.

**Three of the four conditions have automated counterparts** that run on every
`npm test` against whatever the code currently is. Those tests, not the prose
below, are the standing evidence for them:

| Condition | Test |
|---|---|
| Methodology - the file-level variant is unavailable from the CLI | `acceptance: the file-level variant is unavailable from the CLI, and asking for it is refused by name`, in `test/leaks.test.ts` |
| Honesty - a small sample is declared as one | `acceptance: below a hundred merges in a channel the header says the numbers are directional` and `the directional caveat reaches both the machine payload and the human rendering`, in `test/leaks.test.ts` |
| Non-blocking | `acceptance: leaks and calibrate exit 0 whatever the numbers are, and neither takes --strict`, in `test/leaks.test.ts` |

The mechanism behind the fourth - self-sufficiency - is asserted in
`acceptance: the chain from change to pull request to merge commit is rebuilt
from git and GitHub alone` in `test/ledger.test.ts`, which runs with `NM_HOME`
pointed at an empty directory. **The number below is not**, because it is a
statement about one particular repository's real history, and
`docs/stage-3-selfsufficiency.mjs` re-derives it.

## The measured session

Measured on **4 September 2026** against the eyes-on branch head at the time
this document was written - the head of the stage 3 pull request as it was
merged - on macOS 25.2.0, Node v22.21.1, git 2.39.5.

The reference repository is `~/Projects/firstmate/projects/adx-worker`, read
only. Every sweep ran against a temporary state root under `/tmp`, with
`EYES_ON_SKIP_SERVICE_MANAGER=1` so no LaunchAgent was registered and
`NM_HOME` pointed at an empty temporary directory, and stopped the daemon it
started. Nothing from the session persists on the machine.

Deliberately **not** anchored to a commit identifier, for the reason recorded at
the top of `docs/stage-0-acceptance.md`: a SHA taken from a pull-request branch
does not survive the squash-merge that lands it.

## Results

| Test | Criterion | Result |
|---|---|---|
| **Self-sufficiency** | the chain change → pull request → merge commit is rebuilt without the no-mistakes database, from `gh` and git alone, for every merged pull request | **pass** - **153 of 153**, no mismatch and no disagreement |
| Methodology | `leaks` reports the line-level variant only; the file-level variant is unavailable from the CLI | **pass** - four flag names are refused by name with the base rate that is the reason |
| Honesty | below 100 merges in a channel the report header says the numbers are directional | **pass** - in the payload, in the Markdown, and per row |
| Non-blocking | exit 0 without `--strict` | **pass, and stronger than asked** - neither command has a `--strict` at all |

## 1. Self-sufficiency: 153 of 153

```sh
node docs/stage-3-selfsufficiency.mjs
```

The scope report's reference figure is **55 of 55**, taken when it was written.
adx-worker has landed pull requests since: `git log --first-parent origin/main`
now carries **153** commits whose subject ends in `(#N)`. All 153 were measured
and all 153 confirmed, so the criterion is met over a population about three
times the size of the reference.

**What is being measured.** For each merged pull request the script runs
`eyes-on label --pr <n> --dry-run` - the product's own command, not a
reimplementation of the link - and asks whether the two independent sources
named the same commit:

- **git**, through the `(#N)` suffix GitHub writes into a squash-merge subject.
  That suffix is the whole of the git-side link, and it is why nothing is
  written into the commit or into a git note: a squash eats a trailer, and a
  note is a ref, which eyes-on must never write into somebody's clone.
- **GitHub**, through `merge_commit_sha` on one GET of the pull request.

| | count |
|---|---|
| pull requests the branch landed | 153 |
| measured | 153 |
| `link: agrees` - both sources named the same commit | **153** |
| `link: disagrees`, `git-only`, `github-only`, `not-merged`, `neither` | 0 |
| rows whose merge commit differed from the one history shows | 0 |

Median 1.66 s per pull request, 259 s for the sweep. The cost is one gh call
each; the git half is a single `git log --first-parent` for the whole run.

**The no-mistakes database was unreachable, not merely unused.** `NM_HOME`
pointed at an empty temporary directory for the whole sweep, so a fallback onto
it could not have succeeded had one existed. The `link` value in each row names
which sources answered, so a run that had quietly used one source would report
`git-only` or `github-only` rather than `agrees`.

**What 153 of 153 does and does not say.** It says the chain is reconstructible
on a repository that squash-merges every pull request through GitHub, which is
what adx-worker does. It does not say anything about a repository that merges
without squashing: there the subject carries no `(#N)`, `label` would record
`github-only`, and `leaks` could attribute nothing to the merge commit because a
true merge commit introduces no line for blame to name. Both states are
recognised, recorded and reported rather than papered over - `test/leaks.test.ts`
covers the merge-commit case - but the number above is evidence about squash
merges.

It also does not say that a register row could have been written for any of
them: `would_record` is false for all 153, because eyes-on has never assessed
adx-worker's history and `label` refuses to write a line for a change it has no
assessment of. That refusal is the point rather than a gap, and section 4
measures what happens when the assessments do exist.

## 2. Methodology: one variant, and no flag reaches the other

The scope report is explicit (section 5, P6): only the line-level variant, and
the file-level one must be **unavailable from the CLI**, with a comment in the
code saying why so nobody "simplifies" it back in.

A leak is a later fix commit whose blame, taken on that fix's parent, names the
merge commit of a registered change as the commit that introduced the line the
fix removed. The cheaper file-level variant - "a later fix touched a file this
change touched" - has a base rate of **45-73%** on the reference material: on a
repository where most work lands in a handful of hot files nearly every merge
"leaks" by that definition, every channel scores nearly the same, and no
threshold can be argued from it.

Unavailable was implemented as **refused by name**, not as absent:

```
$ eyes-on leaks --file-level
error: eyes-on leaks reports the line-level variant only, so there is no --file-level to pass
help: A leak is a later fix whose blame, taken on that fix's parent, names the merge commit of a registered change
help: The file-level variant - "a later fix touched a file this change touched" - has a base rate of 45-73% on the reference material, so every channel scores nearly the same and no threshold can be argued from it
help: It is not implemented and there is no flag that reaches it; run `eyes-on leaks [--window 14d] [--since 90d]`
```

`--file-level`, `--files`, `--file` and `--variant` all reach that, with exit 2.
Ignoring the flag would have satisfied the condition's letter and failed its
point: a caller who passed one would believe they got the variant they asked
for. `--variant line` is refused too - there is no variant to choose, and
accepting the name of the one that exists would imply there is.

The reasoning is written out at the top of `src/ledger/leaks.ts` rather than
only here, because the file variant is a two-line simplification of the code
beneath it and looks like an optimisation to anybody who has not seen the base
rate.

Every payload carries `variant: line`, in both output formats, so a reader of a
number never has to ask which measurement produced it.

## 3. Honesty: a small sample says it is a small sample

The condition is one sentence: below a hundred merges in a channel, the report
header says the numbers are directional. The number is not a convention. The
reference measurement is 55 merges at a base leak rate of about 28%; separating
two channels whose rates differ by anything a threshold could be moved for takes
on the order of a hundred merges in each of them, so the first reading worth
deciding from arrives after roughly three months at the reference repository's
merge rate.

`src/ledger/sample.ts` is the single place that sentence exists, and both
commands take it from there. No quote of it appears here: a blockquote presented
as command output has to be the output of the session this document reports, and
the numbers in that sentence are the channel sizes of the register measured in
section 4.

Four things about how it is placed:

- it is in the **header**, above the table, in the Markdown rendering, and in
  `sample_sentence` beside a `directional` boolean in the machine payload;
- each channel row also carries its own `directional` flag, because a caveat
  that lives only in the header invites reading one row out of the table;
- a channel with **no** merges counts as short rather than clean. A rate over an
  empty denominator is not a small number, it is no number, and a header that
  stayed quiet about it would let a reader take an absent channel for a clean
  one;
- a table with no channel at all has two causes and gets two different
  sentences. "Nobody has labelled a merge" names the command that fills the
  register; "the register is full and none of its rows has had its window yet"
  names how many rows it holds and why none of them counts, which is what every
  new register looks like for the first fortnight.

`calibrate` takes its header from the same function, so the sweep cannot claim
more than the table it is computed from. It asks a different question of one
register - a pair of thresholds can move merges into a band that is empty today
- so its sentence names the channels those thresholds would produce where
`leaks` names the ones the denominator has merges in. Two headers over one
register, each saying which population it counted, rather than one sentence that
is true of only one of them.

## 4. The register, built over real history

`leaks` and `calibrate` need a register, and a register fills one line at a time
as changes merge - which is the calendar time the report budgets for this stage
and which no test can conjure. To measure the two commands on real material on
the day the code ships, `docs/stage-3-register.mjs` builds one over history:

```sh
node docs/stage-3-register.mjs
```

For every merged pull request it assesses the change *as it landed* - `check
--base <parent> --head <merge> --no-model` - and then labels it.

**What this register is and is not.** The assessments are real: the score, the
hard rules and the band are exactly what eyes-on says about those changes. What
they are not is a record of decisions anybody made. Nobody stated an intent for
a change that merged months ago, so no drift grade was measured and S7 is zero
throughout; nobody answered a gate. So the channel distribution below is
eyes-on's arithmetic over this history, and the leak rates are per that
distribution - what the register will look like, measured on real merges, rather
than what a team decided.

### The register that was built

153 pull requests, 153 register lines, no failure and no disagreement: every row
carries `link: agrees`, which is the same fact section 1 measures from the other
side. 349 s for the whole build, median **2.1 s** per pull request - a `check`
against a warm blame cache, a `label`, and one gh call.

| channel | merges |
|---|---|
| `auto` | 30 |
| `wskazane` | 58 |
| `pelna` | 65 |

Scores ran from 0 to 95 out of a maximum of 120, median 59. No row is
`unverified` (adx-worker has no `.eyes-on.yml`, so the trusted configuration is
**absent**, which is a complete assessment with no hard rules rather than an
unreadable one), no row is `band_from: hard rule`, and no row is parked.

### `eyes-on leaks --window 14d --since 90d`

The whole of adx-worker's merge history falls inside ninety days, so the window
covers all 153. 28 fix commits were blamed; they produced 77 (fix, merge)
attributions over **53 distinct merges**.

| channel | merges | leaked | rate | |
|---|---|---|---|---|
| `auto` | 30 | 5 | **17%** | directional (< 100) |
| `wskazane` | 58 | 21 | **36%** | directional (< 100) |
| `pelna` | 65 | 27 | **41%** | directional (< 100) |

Overall 53 of 153, **35%** - near the 28% the hundred-merge threshold was
reasoned from. Nothing was excluded from the denominator: all 153 merge commits
are squash merges with one parent.

**The ordering is the right way round, and that is the whole of what it says.**
The channel eyes-on would have let through unread leaks least often and the
channel it would have sent for full review leaks most often, which is a risk
score agreeing with what later happened. It is not evidence that reading causes
leaks and not evidence that any threshold should move: eyes-on was not running
on this repository, nobody read anything because of a channel, and every channel
is under a hundred merges, which is exactly the state section 3's header
declares.

**What "leaked" counts here.** A later fix commit whose blame names the merge -
not an incident, and not a production failure. On this material the median gap
between a merge and the first fix that blames it is **one day**, and 25 of the
53 are fixed the same day. That is a repository iterating on its own work inside
a release, and it is what a fourteen-day window over a ninety-day history of a
small hot repository will mostly catch. The measure is the one the report
specifies and it discriminates between the channels; what it discriminates on is
"a later commit rewrote lines this one introduced", and a reader should hold it
at that.

### `eyes-on calibrate`

276 pairs swept at a step of 5 over a maximum score of 120. The thresholds in
force are the report's defaults, 35 and 65:

| read / full | auto merges | auto leaked | auto rate | read share | |
|---|---|---|---|---|---|
| 100 / 105 | 153 | 53 | 35% | 0% | |
| 90 / 95 | 141 | 50 | 36% | 8% | |
| 80 / 85 | 115 | 39 | 34% | 25% | |
| 70 / 75 | 91 | 29 | 32% | 41% | |
| 60 / 65 | 79 | 24 | 30% | 48% | |
| 50 / 55 | 55 | 14 | 26% | 64% | |
| 40 / 45 | 37 | 9 | 24% | 76% | |
| **35 / 65** | **30** | **5** | **17%** | **80%** | in force |
| 30 / 35 | 26 | 4 | 15% | 83% | |
| 25 / 30 | 23 | 4 | 17% | 85% | |
| 5 / 10 | 19 | 3 | 16% | 88% | |

The frontier - for each size of the automatic channel, the pair that leaks least
- plus the pair in force. **No candidate**, and the command says why:

> No pair on the grid keeps the `auto` channel at or below its current leak rate
> of 17% while sending less than the current 80% of merges to a human, so this
> history argues for no change. 16 pairs score exactly what the pair in force
> scores: the two numbers this sweep ranks on cannot tell `wskazane` from
> `pelna`, so a pair that only moves the boundary between the two reading
> channels is not a different answer.

That second sentence is a defect this measurement found and the code now avoids.
The first version of the sweep ranked ties by an arbitrary end of the grid and
named **35 / 120** as its candidate beside a current 35 / 65: arithmetically
identical on both numbers it ranks, and an instruction to abolish the
full-review channel for no measured gain. A tie is not a different answer, and
saying so is now what the command does - `a pair that ties with the one in force
is not a candidate, however the grid is ordered`, in `test/leaks.test.ts`.

**One observation worth the captain's attention, stated as an observation.** At
the report's default thresholds this repository sends **80% of its merges to a
human**, because its median change scores 59 out of 120. That is the arithmetic
working as specified rather than a defect - and it is also not what a threshold
is usually set for. The evidence to move it is the register, and the register
says nothing yet: every channel is under a hundred merges, and the pairs that
would send less to a human all cost more in the automatic channel on this
sample. Three more months of merges is the answer, which is exactly what the
report budgets for this stage.

## 5. Not measured

- **Whether a channel's leak rate differs from another's.** That is the whole
  point of the register and it is exactly what this sample cannot yet answer;
  section 3 is the machinery that keeps the report from claiming otherwise. The
  first reading worth deciding from is about three months of merges away.
- **Repositories that merge without squashing.** Section 1 says why the two
  halves of the mechanism both degrade there, and both degradations are
  recognised and reported. Neither has been measured on a real repository of
  that shape, because the reference one does not have that shape.
- **A register filled as changes merge, rather than reconstructed.** The
  distinction is stated in section 4 and it matters: a real register carries
  drift grades and gate decisions, and this one carries neither.
- **The blame cost on a repository much larger than adx-worker.** `leaks` walks
  the same history `check` does and shares its blame cache, so its cost is the
  stage 1 cost plus one pass; that was not measured against a repository of a
  different order of size.
- **Whether a "leak" is a defect that reached anybody.** It is a later commit
  rewriting lines this one introduced, and on this material the median gap is
  one day. Section 4 says so where the number is. Tying a register row to an
  incident would need an incident record, which this repository does not keep.
- **The boundary between `wskazane` and `pelna`.** The sweep ranks on what the
  automatic channel leaks and on how much reading is paid, and neither number
  can see that boundary. So `calibrate` can argue about which changes go unread
  and cannot argue about how much a read change should be read; it says so
  rather than ranking a tie.
- **Windows and Linux.** As in stages 0 to 2, the session was macOS only.

## 6. Stage 2's outstanding measurement, settled

`docs/stage-2-acceptance.md` carried one figure with a caveat: the stage 2
locality number, 18 of 20, was measured before the agent's working directory
moved under the eyes-on state root, so it was evidence about a `claude -p`
started inside the adx-worker clone - reading that repository's own `CLAUDE.md`
and `.claude/settings.json` - rather than about what shipped.

That sweep has been re-run against the shipped configuration - an agent started
in `Paths.agentDir` with the prompt on stdin and nothing pointing at the clone -
twice, as before, because a model call is not deterministic and one run would
not show whether the number is.

| | hits | rate |
|---|---|---|
| stage 1 alone (`--no-model`), deterministic | 16 / 20 | 80% |
| stage 2, run 1 | 17 / 20 | **85%** |
| stage 2, run 2 | 17 / 20 | **85%** |
| stage 2, before the working directory moved | 18 / 20 | 90% |

The criterion is 40%, so the condition still passes with room. **The caveat is
removed and the figure of record is 17 of 20.** What moved is one pull request
in twenty - one case at this sample size, reported because it is the
measurement - and, more interestingly, the stability of *which* pull requests
are missed: the earlier pair of sweeps missed the same two in both runs, and
these two agree on two misses and disagree on the third. The full table, the
per-pull-request comparison and the rest of what changed are in
`docs/stage-2-acceptance.md` section 1.
