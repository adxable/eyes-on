# Stage 2 acceptance

Stage 1 answers *whether* a human has to read a change. Stage 2 answers *what*:
three to five fragments, the diff compared against the intent its author stated,
a gate that refuses to call a rule-protected change decided until somebody says
what they decided, and one sticky pull-request comment carrying the result.

As in stages 0 and 1, the evidence comes in two kinds and they age differently.

**Four of the five conditions have automated counterparts** that run on every
`npm test` against whatever the code currently is. Those tests, not the prose
below, are the standing evidence for them:

| Condition | Test |
|---|---|
| Emergency mode | `acceptance: --no-model returns stage 1 and does not call a model once`, in `test/spotlight.test.ts` |
| Disjointness in the pull request | `acceptance: publishing leaves the pull-request body byte for byte, and leaves exactly one comment`, in `test/comment.test.ts`, and `acceptance: no gh invocation can edit a pull request, merge one, or review one` in `test/coexistence.test.ts` |
| The gate | `acceptance: a hard-rule hit parks the run, and parking changes no exit code`, `acceptance: a waiver records the decision, the reason and who gave it` and `acceptance: an unanswered gate blocks nothing but the eyes-on run`, in `test/gate.test.ts` |
| Drift does not gate | `acceptance: drift is shown and changes no exit code, at any grade`, in `test/drift.test.ts` |

**The fifth - locality - has no automated counterpart**, because it is a
statement about one particular repository's history compared with what one
particular reviewer said about it. It was measured in the session described
below, and `docs/stage-2-locality.mjs` re-derives it.

## The measured session

Measured on **2 September 2026** against the eyes-on branch head at the time this
document was written - the head of the stage 2 pull request as it was merged -
on macOS 25.2.0, Node v22.21.1, git 2.39.5.

The reference repository is `~/Projects/firstmate/projects/adx-worker`, read
only. The reviewer material is the no-mistakes pipeline database, opened through
`?mode=ro`: **203 anchored findings** across 58 pull requests at the time of
measurement. (The scope report's brief cites 182; the database has grown since.)

The session ran against a temporary state root under `/tmp`, with
`EYES_ON_SKIP_SERVICE_MANAGER=1` so no LaunchAgent was registered, and the daemon
it started was stopped afterwards. Nothing from the session persists on the
machine.

Deliberately **not** anchored to a commit identifier, for the reason recorded at
the top of `docs/stage-0-acceptance.md`: a SHA taken from a pull-request branch
does not survive the squash-merge that lands it.

## Results

| Test | Criterion | Result |
|---|---|---|
| Locality, stage 1 alone | the fragments land in a file the reviewer commented on, in ≥ 40% of the last 20 merged pull requests | **pass** - 16 of 20, **80%** |
| Locality, stage 2 (model) | the same, with the model choosing | **pass** - 18 of 20, **90%** |
| Disjointness in the pull request | the body is byte-for-byte identical, and there is exactly one eyes-on comment however many recomputations | **pass** |
| The gate | a hard-rule hit parks the run; `respond --action waive --reason` records the decision and the reason; no answer blocks anything but the eyes-on run | **pass** |
| Emergency mode | `--no-model` returns stage 1 and calls no model once | **pass** |
| Drift does not gate | the drift grade does not change an exit code | **pass** |

## 1. Locality

```sh
node docs/stage-2-locality.mjs          # stage 1 only, deterministic
node docs/stage-2-locality.mjs --model  # with the second stage
```

The method: take the last twenty merged pull requests on `origin/main` that
carry at least one anchored no-mistakes finding, identified by the `(#N)` suffix
a squash merge leaves in the subject. For each, run `spotlight` over the merge
commit against its first parent, and ask whether any of its three-to-five
fragments names a file the reviewer anchored a finding to.

**What this number is and is not.** A no-mistakes finding is where one reviewer
looked and had something to say. It is not a list of everything worth reading in
that change, so a fragment in a file with no finding is not necessarily a miss.
The number measures *agreement with a reviewer*, and that is the strongest claim
the material supports.

### Stage 1 alone: 16 of 20, 80%

| PR | fragments | files | candidates | candidate files | files the reviewer touched | hit |
|---|---|---|---|---|---|---|
| 179 | 5 | 3 | 12 | 7 | 5 | yes |
| 178 | 5 | 4 | 12 | 9 | 5 | yes |
| 177 | 5 | 2 | 5 | 2 | 2 | yes |
| 176 | 5 | 5 | 12 | 9 | 3 | yes |
| 175 | 5 | 3 | 12 | 6 | 3 | yes |
| 174 | 5 | 4 | 12 | 6 | 3 | yes |
| 173 | 5 | 4 | 12 | 6 | 3 | yes |
| 172 | 5 | 4 | 12 | 6 | 2 | yes |
| 171 | 5 | 3 | 7 | 3 | 4 | yes |
| 170 | 5 | 3 | 12 | 8 | 4 | yes |
| 169 | 5 | 5 | 12 | 10 | 2 | **no** |
| 168 | 5 | 2 | 12 | 3 | 3 | yes |
| 166 | 5 | 4 | 12 | 8 | 1 | yes |
| 165 | 5 | 3 | 12 | 6 | 1 | **no** |
| 164 | 5 | 4 | 12 | 8 | 4 | **no** |
| 163 | 5 | 2 | 12 | 5 | 6 | yes |
| 162 | 5 | 4 | 12 | 6 | 3 | yes |
| 161 | 5 | 3 | 12 | 5 | 4 | yes |
| 155 | 5 | 4 | 12 | 8 | 4 | **no** |
| 160 | 5 | 2 | 12 | 2 | 2 | yes |

Median time per pull request: **1.13 s** against a warm blame cache, 37 s for the
whole sweep.

The four misses are #169, #165, #164 and #155. The reviewer anchored findings in
one file on #165 and in two on #169: with five fragments drawn from twelve
candidates over a change touching dozens of files, missing a one-file target is
what the arithmetic should be expected to do rather than a defect. #164 and #155
are the harder pair - four reviewer files each, and stage one still went
elsewhere.

### Stage 2, with the model choosing: 18 of 20, 90%

The same twenty pull requests, with the second stage running against `claude -p`
for real - one call each, twenty calls in total. The sweep was run twice and
both runs gave 18 of 20 with the same two misses, which is worth recording
because a model call is not deterministic and one run would not have shown
whether the number was.

| | hits | rate | median wall clock |
|---|---|---|---|
| stage 1 alone (`--no-model`) | 16 / 20 | **80%** | 1.13 s |
| stage 2 (model chooses) | 18 / 20 | **90%** | 11.7 s |

The model recovered two of stage one's four misses - #164 and #165 - and lost
none: its two misses, #169 and #155, are both in stage one's four. That is worth
saying plainly rather than as an improvement: the second stage chooses better
within the candidate set, and it cannot rescue a candidate set that never
contained the reviewer's file.

It also narrowed the answer, from a median of 3.5 distinct files among the five
fragments to 3.0, and returned four fragments rather than five on one pull
request - it is asked for three to five and is not obliged to fill the range.

Ten seconds per pull request against one is the cost of the second stage: 255 s
for the sweep against 37 s. That ratio is why `--no-model` is a first-class
answer rather than a fallback, and why the second stage is one call rather than
one per fragment.

Here is what stage two actually returns, on pull request #178 (`eyes-on spotlight
--format md`, five fragments out of twelve candidates from the 37 rankable hunks
of the change's 52):

```
# eyes-on spotlight - 5 fragments to read

Change c2a5a612ed5c..c0d9a905c0ea, score 86 of at most 120, band **full review**.
Stage 2: 12 candidates from 37 hunks. the model answered

## Read these places

1. `packages/worker-runtime/src/vm/main.ts:202` - correctness - Check that the badge is
   wired whenever the inbox source exists and that the views source is built after the
   inbox, so the count is never silently omitted on a VM that can read the quarantines.
2. `packages/client-view/src/view-descriptor.ts:217` - correctness - Check every consumer
   of NavTreeViewSchema.counts for the relaxation from required to optional - anything
   that read counts.inbox/schedule unconditionally now gets undefined.
3. `packages/worker-runtime/src/vm/panel-inbox.ts:351` - correctness - Check that
   swallowing every exception here (not just read failures) and returning null is the
   intended contract, and that decidableItems is the same rule the Skrzynka screen applies.
4. `packages/worker-runtime/dev/panel-demo.ts:667` - correctness - Check that removing the
   retired-front-door shim really leaves the router answering those four addresses now
   that a content source is bound, since no test changed alongside this file.
5. `packages/panel-app/src/shell/Sidebar.tsx:72` - correctness - Check that besideAppHref
   builds the panel base (not the app base) for all three segments and that leaving the
   SPA with a plain anchor is correct for these server-rendered pages.
```

Across the hundred fragments the twenty pull requests produced, the categories
were:

| category | fragments |
|---|---|
| `correctness` | 78 |
| `security` | 9 |
| `maintainability` | 8 |
| none | 5 |

**All five uncategorised fragments are the five of a single pull request** -
#168, where the model call did not produce a usable answer and the command fell
back to stage one, which does not categorise. So **every fragment the model
chose carried one of the three taxonomy categories, and none came back as a
style or formatting remark**: a category outside the taxonomy is recorded as
none rather than mapped onto the nearest one, so a style remark would have shown
up in that column.

That prohibition is why the prompt states it in the measurement's own terms.
From the research report's section 1.3: against 18,000 human review comments, AI
reviewers under-report correctness by 42.6% and security by 89.5% while
over-reporting style by 328%.

#168 is also the honest demonstration of the fallback: it still returned five
fragments, still hit, and reported `stage: 1` while doing it.

The same change under `--no-model` ranks by the arithmetic alone. Two of the five
fragments it picks are in `dev/panel-demo.ts`, which the model dropped in favour
of `src/vm/main.ts` and `src/client-view/view-descriptor.ts`; every sentence is
made of the terms that ranked the fragment rather than of anything read in it:

```
spotlight[5]{file,line,category,why,weight,source}:
  packages/worker-runtime/dev/panel-demo.ts,667,,58 changed lines in a file the history
    scores 31/100; a past fix blamed the commit that wrote the lines it changes; no test
    changed alongside it.,3236.4,rank
  packages/worker-runtime/src/vm/panel-inbox.ts,351,,37 changed lines in a file the
    history scores 34/100; ...,2264.4,rank
  ...
  packages/worker-runtime/src/ingress/panel-serve.ts,1894,,7 changed lines in a file the
    history scores 77/100; ...,970.2,rank
```

That is the honest shape of stage one: a real ranking with an empty category
column, because the arithmetic knows a fragment is worth reading and not what
kind of thing it is.

## 2. The noise filter reaches the fragment ranking too

The first version of `spotlight` ranked every hunk in the diff. On pull request
#178 the fragment it hit on was `AGENTS.md` - which is exactly the failure stage
1 measured and fixed for the risk ranking, reappearing one level down.

The ranking now considers hunks in **code files by the trusted `include`
patterns, plus any file a hard rule names**. The union is the point: a hard rule
exists to reach a `deploy/values.yaml` that no code filter would keep, and
filtering it out here would make the strongest guarantee in the product depend
on a list of file extensions.

The hit rate is unchanged at 80% either way - the filter moved four pull
requests from four fragment-files to three or two, and #178's hit moved from
`AGENTS.md` to `packages/panel-app/src/shell/Sidebar.tsx`. It is kept because the
fragments it removes are places nobody should be sent, not because it improved a
number.

## 3. The per-file cap, argued from the measurement rather than from taste

The stage 1 formula is a product with an unbounded size term, so one large hunk
in a high-risk file outranks every fragment of every other file. A cap of three
hunks per file in the twelve-candidate set was added on that reasoning and then
measured against no cap at all:

| | median distinct files among the 12 candidates | hit rate |
|---|---|---|
| cap of 3 per file | **7.5** | 80% |
| no cap | 6.0 | 80% |

The cap changed the final three-to-five fragments on **zero** of the twenty pull
requests, and the candidate set on **twelve** of them - by up to five files
(#170: eight files against five; #160: five against three).

So it is kept for what it actually does: it widens the menu the second stage
chooses from, in most changes, at no measured cost. It is not kept on the claim
that it improves locality, because it does not.

The cap is `DEFAULT_MAX_PER_FILE` in `src/spot/rank.ts`. A shortfall is filled
back from what the cap held back, so a change that touches one file still gets
its full twelve candidates - the cap must not decide the answer for a change
that has nothing to diversify into.

## 4. Disjointness in the pull request

Two properties, and only one of them is a comparison.

**The body is byte-for-byte identical.** `test/comment.test.ts` keeps a
pull-request body in a fake `gh`, publishes the comment three times over three
recomputations, and compares.

**No code path could have touched it.** This is the stronger statement and the
one that will still hold after somebody adds a command. `gh()` in `src/gh/gh.ts`
is module-private and every invocation passes `assertAllowed` first; the
allow-list is four whole command shapes, of which two are writes and both are
issue-comment endpoints:

```
GET    repos/<owner>/<repo>/issues/<n>/comments
GET    repos/<owner>/<repo>/pulls/<n>
POST   repos/<owner>/<repo>/issues/<n>/comments
PATCH  repos/<owner>/<repo>/issues/comments/<id>
```

`PATCH repos/<owner>/<repo>/issues/<n>` - the endpoint that edits a pull request
body - differs from the permitted comment update by one path segment. That is
why the paths are matched whole rather than a list of verbs being forbidden:
a deny-list would have to keep up with every endpoint GitHub adds, and the first
one it missed would be a silent breach of the prohibition the product exists to
be trusted about. `test/coexistence.test.ts` asserts thirteen refusals and four
permissions against the same function the code calls.

**Exactly one comment.** The marker `<!-- eyes-on:v1 {...} -->` is written first,
on its own line, with a single-line JSON payload. Every publish searches for the
prefix and updates the comment it finds; only its absence creates one. The
listing is parsed as a *sequence* of JSON arrays rather than as one document,
because `gh api --paginate` concatenates one array per page - a pull request with
more than thirty comments would otherwise silently fail to find the marker and
post a second comment on every run.

## 5. The gate

A hard rule matching sets the band to `pelna`, which is a statement about the
change. The gate turns it into a statement about a person: `status` becomes
`must_read` and stays there until `eyes-on axi respond` records what was decided.

```
$ eyes-on check --format json | jq '{band, gate, decision}'
{ "band": "pelna", "gate": "must_read", "decision": null }          # exit 0

$ eyes-on axi respond --action waive --reason "agreed in the deploy review"
check_id: ...
gate_was: must_read
gate: none
status: done
action: waive
reason: agreed in the deploy review
decided_by: crewmate                                                # exit 0
```

Three things about it are asserted rather than described:

- **a waiver must say why.** `--action waive` with no `--reason`, or with
  whitespace, is a usage error and records nothing.
- **the park releases only the eyes-on run.** With the gate open, `status`,
  `rules --check`, `spotlight`, `why` and `doctor` all still work and all exit 0.
  `--strict` is still the only thing in the product that produces a non-zero
  exit, and it is about the band rather than about the gate.
- **decisions accumulate.** A second answer is appended, because "waived on
  Monday, read in full on Tuesday" is a true sentence about a change and the
  record has to be able to say it. Re-running `check` after an answer does not
  reopen a gate somebody already closed.

Who answered comes from `EYES_ON_ACTOR` when it is set, else the account name.
An agent driving the command is not the account it happens to run under, and the
ledger in stage 3 should be able to say which.

## 6. Emergency mode

`--no-model` is not a degraded answer with an apology attached. It returns stage
one complete, says `stage: 1` and `model_state: skipped`, and every fragment
carries `source: rank` and a **null category** - the arithmetic knows a fragment
is worth reading, not what kind of thing it is, and guessing would be the one
place this product invents a fact.

That it calls nothing is structural rather than careful: `modelOptionsFor` is
the only place the flag is read and it returns `null`, so there is no branch
anywhere that reaches `askModel` with the flag set. The test asserts it against a
fake agent that records every invocation, so "it did not call the model" is the
absence of a file the suite would otherwise have written.

The same path carries three other cases, each with its own sentence rather than
one shared shrug: a repository whose `model.command` is explicitly empty
(`skipped`), an agent that is not installed (`unavailable`), and a command naming
an executable eyes-on does not know (`refused`).

## 7. Drift does not gate

`eyes-on drift` exits 0 for a grade of 5 exactly as it does for a grade of 1, and
`--strict` does not change that: `--strict` is about the band, and drift does not
set a band. The grade does raise the risk score through S7 at weight 0.20, which
is where "worth reading" is expressed - but the score never produces a non-zero
exit either.

The mechanism is two model calls, and that is asserted by reading the prompts
that were actually sent: the first contains the diff and not the intent, the
second contains the intent and the first pass's description and no code. A single
call shown both reads the diff through the intent and reports an agreement it
never checked, which is a command that runs, costs money and means nothing.

**S7 is the grade minus one**, so a change graded 1 - the diff doing exactly what
its author said - contributes nothing. Feeding the grade itself would add eight
points to every change that bothered to state an intent and had it confirmed,
which punishes the measurement rather than the drift. The cost of that choice is
that S7 reaches 18 of the 20 points its weight allows rather than 20, because the
report's saturation constant for drift is 5 while the raw value can only reach 4.

The weights now sum to 1.20 with the thresholds unchanged at 35 and 65, exactly
as the report specifies, so a fully drifted change can score above 100. Every
rendering divides by `maxScore()` rather than by a literal hundred.

## 8. The clone and the foreign state root were not touched

Captured on adx-worker immediately before the session and again after it, with a
marker file stamped between them:

| Probe | Before | After |
|---|---|---|
| `git status --porcelain` | 0 lines | identical |
| `git for-each-ref` | 369 lines | identical |
| `git config --local --list` | 18 lines | identical |
| `git remote -v` | 4 lines | identical |

The stage 0 and stage 1 caveat applies again and was observed again:
`~/.no-mistakes/telemetry-gate.json` is written while eyes-on runs, by
**no-mistakes itself**, whenever any lane on this machine invokes `no-mistakes
axi`. Nothing else under `~/.no-mistakes` changed, and eyes-on's own reads of
that database go through `?mode=ro`.

## Not measured

- **Whether the fragments were the right ones.** Locality measures agreement
  with one reviewer's anchors, not correctness. Whether a reader who followed the
  spotlight caught what mattered is a question for stage 3's `leaks`.
- **The second stage's cost in tokens.** The measurement records wall-clock time
  per pull request, not the model's own accounting.
- **Model agents other than `claude`.** `codex`, `copilot`, `cursor-agent`,
  `opencode`, `pi` and `rovodev` are accepted by name and none was run: each reads
  a prompt differently, and defaulting to a flag nobody here has exercised would
  be a diagnostic promising a remedy that does not work. Only `claude` is
  defaulted to, and only when it is actually on PATH.
- **Repositories other than adx-worker and the suite's own fixtures.**
- **Windows and Linux.** As in stages 0 and 1, the session was macOS only.
