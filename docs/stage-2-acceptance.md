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
| The gate | `acceptance: a hard-rule hit parks the run, and parking changes no exit code`, `acceptance: a waiver records the decision, the reason and who gave it`, `acceptance: an unanswered gate blocks nothing but the eyes-on run` and `a decision answers the rules it was shown, so a rule that appears later parks the change again`, in `test/gate.test.ts` |
| Drift does not gate | `acceptance: drift is shown and changes no exit code, at any grade` and `acceptance: the drift grade gates only through the band, and only when --strict asks it to`, in `test/drift.test.ts` |

**The fifth - locality - has no automated counterpart**, because it is a
statement about one particular repository's history compared with what one
particular reviewer said about it. It was measured in the session described
below and re-measured in the stage 3 session against the shipped agent
configuration; `docs/stage-2-locality.mjs` re-derives it.

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
| Locality, stage 2 (model) | the same, with the model choosing | **pass** - 17 of 20, **85%**, over two runs; re-measured against the shipped configuration in the stage 3 session, see section 1 |
| Disjointness in the pull request | the body is byte-for-byte identical, and there is exactly one eyes-on comment however many recomputations | **pass** |
| The gate | a hard-rule hit parks the run; `respond --action waive --reason` records the decision and the reason; no answer blocks anything but the eyes-on run | **pass** |
| Emergency mode | `--no-model` returns stage 1 and calls no model once | **pass** |
| Drift does not gate | the drift grade does not change an exit code | **pass, with one stated exception** - `eyes-on drift` exits 0 at every grade, with `--strict` or without it, and `eyes-on check` without `--strict` does too. Under `check --strict` the grade gates through the band exactly like every other signal. See section 7 |

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
whole sweep; re-run in the stage 3 session it gave 1.20 s and 40 s, and the same
sixteen hits and four misses.

The four misses are #169, #165, #164 and #155. The reviewer anchored findings in
one file on #165 and in two on #169: with five fragments drawn from twelve
candidates over a change touching dozens of files, missing a one-file target is
what the arithmetic should be expected to do rather than a defect. #164 and #155
are the harder pair - four reviewer files each, and stage one still went
elsewhere.

### Stage 2, with the model choosing: 17 of 20, 85%

The same twenty pull requests, with the second stage running against `claude -p`
for real - one call each, twenty calls per sweep. The sweep is run twice and
both figures are reported, because a model call is not deterministic and one run
would not show whether the number was.

When stage 2 shipped, both runs gave 18 of 20 with the same two misses. The
figure that stands is the one below, re-measured against what the code actually
ships.

### Re-measured against the shipped configuration, 4 September 2026

This figure carried a caveat when stage 2 shipped, and the caveat is now
settled. The original 18 of 20 was measured **before the agent's working
directory moved under the eyes-on state root** (section 6): both sweeps ran a
`claude -p` started inside the adx-worker clone, so it read that repository's
own `CLAUDE.md` and `.claude/settings.json`, which the shipped code no longer
gives it. That was a different measurement instrument, and which way the number
would move was not known.

Both sweeps were re-run in the stage 3 session against the shipped
configuration - an agent started in `Paths.agentDir` with the prompt on stdin
and nothing pointing at the clone - on the same twenty pull requests. **17 of
20, 85%, in both runs.** The criterion is 40%.

| | hits | rate | median wall clock |
|---|---|---|---|
| stage 1 alone (`--no-model`) | 16 / 20 | **80%** | 1.20 s |
| stage 2 (model chooses), run 1 | 17 / 20 | **85%** | 11.5 s |
| stage 2 (model chooses), run 2 | 17 / 20 | **85%** | 11.7 s |
| stage 2, before the working directory moved | 18 / 20 | 90% | 11.7 s |

**What moved, and what it is worth.** The rate fell by one pull request in
twenty, from 90% to 85%. Over a sample of twenty that difference is one case;
it is reported because it is the measurement, not because the two are
distinguishable. What did change in a way worth naming is the **stability of
which** pull requests are missed. The earlier pair of sweeps missed #169 and
#155 in both runs. These two miss #169 and #155 in both runs and then disagree
on the third: run 1 also missed #164, run 2 also missed #178. A model call is
not deterministic and one run would not have shown that, which is why the sweep
is run twice.

| PR | stage 1 | model run 1 | model run 2 | files the reviewer touched |
|---|---|---|---|---|
| 179 | yes | yes | yes | 5 |
| 178 | yes | yes | **no** | 5 |
| 177 | yes | yes | yes | 2 |
| 176 | yes | yes | yes | 3 |
| 175 | yes | yes | yes | 3 |
| 174 | yes | yes | yes | 3 |
| 173 | yes | yes | yes | 3 |
| 172 | yes | yes | yes | 2 |
| 171 | yes | yes | yes | 4 |
| 170 | yes | yes | yes | 4 |
| 169 | **no** | **no** | **no** | 2 |
| 168 | yes | yes | yes | 3 |
| 166 | yes | yes | yes | 1 |
| 165 | **no** | yes | yes | 1 |
| 164 | **no** | **no** | yes | 4 |
| 163 | yes | yes | yes | 6 |
| 162 | yes | yes | yes | 3 |
| 161 | yes | yes | yes | 4 |
| 155 | **no** | **no** | **no** | 4 |
| 160 | yes | yes | yes | 2 |

The stage 1 figure is **unchanged at 16 of 20**, with the same four misses, and
it takes no caveat in either session: it is deterministic arithmetic with no
model in it at all, so the working directory an agent would have been started in
cannot touch it. That it did not move while the reviewer material grew from 182
anchored findings to 203 is itself a small piece of evidence that the twenty
pull requests are not sitting on a knife edge.

Against stage 1, the model still recovers #165 - a one-file target stage one's
twelve candidates went past - and in run 2 recovers #164 as well. Neither run
rescues #169 or #155, and neither can: the second stage chooses within the
candidate set the arithmetic produced, and it cannot reach a file that set never
contained.

It also narrowed the answer, from a median of 3.5 distinct files among the five
fragments to 3.0 in both runs, and returned four fragments rather than five on
#177 in both - it is asked for three to five and is not obliged to fill the
range. Its categories over the two runs were 156 `correctness`, 27 `security`
and 15 `maintainability`, and no `style` at all, which is what the prompt
forbids.

Ten seconds per pull request against one is the cost of the second stage: 248 s
and 256 s for the two sweeps against 40 s. That ratio is why `--no-model` is a
first-class answer rather than a fallback, and why the second stage is one call
rather than one per fragment.

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
one that will still hold after somebody adds a command. No caller anywhere
writes a gh argument vector: a caller names one of six operations and
`src/gh/gh.ts` holds the six vectors literally. Four read and two write, and
both writes are issue-comment endpoints:

```
gh repo view --json nameWithOwner --jq .nameWithOwner
gh auth status
GET    repos/<owner>/<repo>/pulls/<n>
GET    repos/<owner>/<repo>/issues/<n>/comments   (--paginate)
POST   repos/<owner>/<repo>/issues/<n>/comments
PATCH  repos/<owner>/<repo>/issues/comments/<id>
```

`PATCH repos/<owner>/<repo>/issues/<n>` - the endpoint that edits a pull request
body - differs from the permitted comment update by one path segment, and has no
operation, so no vector for it can be built.

This replaced an allow-list that parsed the vector, and the reason is the shape
rather than the two bugs it had. To decide read from write, that parser had to
reproduce `gh api`'s own argument semantics, and review rounds found these
divergences: pflag's attached shorthand `-XPATCH` read as a GET of a read path,
and then the implicit method, where a vector carrying `--input` and no
`--method` is sent by gh as a POST and was validated against the read table.
Each fix was correct and the next round found another; a defence that must model
another program's parser is only as good as the model. `test/coexistence.test.ts`
asserts every one of those vectors is refused, that the six are accepted, and
that a hostile slug or number is refused before it reaches a path - all against
the same functions the code calls.

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
answered_hits[1]{glob,file}:
  deploy/**,deploy/values.yaml
answered_config_sha: 4f2c1ab9e0d7
status: done
action: waive
reason: agreed in the deploy review
decided_by: crewmate
decisions[1]{action,reason,decided_by,decided_at,answers_these_hits}:
  waive,agreed in the deploy review,crewmate,1756800000,true         # exit 0
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
  reopen the gate that answer closed.
- **an answer covers the rules it was shown, and no others.** The decision
  records the hard-rule hits it was given against (`hits_fingerprint`) and the
  configuration they came from (`config_sha`), and `decisionCovering` asks
  whether *these* hits were answered rather than whether the check was. So
  answering a change no rule matched, and then adding a rule on the default
  branch that reaches it, parks the change again rather than leaving it
  pre-waived - which is what `a decision answers the rules it was shown, so a
  rule that appears later parks the change again` asserts in `test/gate.test.ts`.

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
the only place the flag *decides* anything - it returns `null`, and every caller
checks `null` before building a prompt, so there is no branch anywhere that
reaches `askModel` with the flag set. Three commands read the flag again, but
only to choose what their output says about a model they were already unable to
call; none of them decides reachability. The test asserts it against a fake agent
that records every invocation, so "it did not call the model" is the absence of a
file the suite would otherwise have written.

The same path carries four other cases, each with its own sentence rather than
one shared shrug: a repository whose `model.agent` is explicitly empty
(`skipped`), an agent that is not installed (`unavailable`), a name eyes-on does
not know (`refused`), and a name it knows but has never invoked, so it holds no
argument vector for it and refuses rather than guessing one (`refused`).

**A repository chooses the agent's name and nothing else.** `model.command` -
an argument vector supplied by the repository being assessed - is honoured only
under `allow_any_command` in the machine's own `~/.eyes-on/config.yaml`, and is
otherwise refused by name. This diverges from Appendix C.3, which specifies
`model.command: ["claude", "-p"]`: flags reach `spawnSync` and the prompt they
govern is built from the same repository's diff, so a vector from that
repository is repository-controlled input to process execution.
`test/spotlight.test.ts` asserts the argv the agent was actually invoked with,
and that a planted `tools/claude` is never executed.

**And it does not choose the agent's working directory either.** The agent is
started in `<state root>/agent`, a directory eyes-on creates and owns, rather
than in the clone. The consequence, stated plainly because it changes what a
real `claude` sees: the agent no longer reads the assessed repository's agent
configuration or instruction files - a `.claude/settings.json` and a `CLAUDE.md`
added by the branch under review are simply not on its path any more. What that
means for the result is that the prompt is self-contained by construction, so
the fragments and the drift grade are computed from the text eyes-on supplies
on stdin and from nothing the repository can add. The working directory was one
more disguise of one vector - the program's path, then its argv, then the
directory it starts in - so it is closed the same way the others were:
`modelOptionsFor` is the only place a cwd is chosen. `test/spotlight.test.ts`
asserts the directory the agent was actually run in.

## 7. Drift does not gate

`eyes-on drift` exits 0 for a grade of 5 exactly as it does for a grade of 1,
with `--strict` or without it, because that command computes no band and there
is nothing for `--strict` to act on. `eyes-on check` without `--strict` exits 0
at every grade too.

**The exception, and why it exists.** The brief asked for two things that cannot
both hold: "the drift result does not change any exit code", and "S7 at weight
0.20 with the thresholds left at 35 and 65". The band is a function of the
score, S7 is part of the score, and `--strict` exits 1 on a `pelna` band - so a
drift grade high enough can carry a change over `full_review` and produce a
non-zero exit under `check --strict`. The same change with `--no-model`, or
without `--intent`, exits 0 - unless a grade for the same intent is already
recorded against that base..head, in which case it is carried and scored, and
the run reaches the same band. Not measuring is not changing, and the surface
says which of the two happened.

Resolved in favour of coherence: **drift enters the score and therefore the
band, and `--strict` remains the caller's explicit consent to gate on the band.**
The alternative - excluding S7 from the band that `--strict` reads - was
rejected, because it would leave `check` printing a score and a band that
disagree about one change, which is the class of incoherence this project has
been removing since stage 0.

So the criterion is met as: no drift grade changes an exit code except under the
explicitly opted-in `--strict`, where it gates through the band exactly like
every other signal. Both directions are locked in by `acceptance: the drift
grade gates only through the band, and only when --strict asks it to` in
`test/drift.test.ts`, which puts the `full_review` threshold between the score
without drift and the score with it and then asserts the exit code with
`--strict`, without it, and with `--no-model`.

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

## 8. What this session found, beyond the conditions

**A drift measurement that was confidently wrong, caught only by running it
against a real model.** The stubbed tests proved the two passes happen, that the
first never sees the intent and the second never sees the code, and that a
failure at either end leaves no grade. They could not catch this, because it is
not a control-flow property.

The prompt budget for the first pass is 40 KB, and git orders its diff output by
path. A change larger than that was therefore described from its alphabetically
first files - on this branch, `AGENTS.md` and `README.md` - and the second pass,
comparing that description with the intent, reported that four of the five
things the change actually did were **missing from it**:

```
# eyes-on drift - 3/5
- asked for, not in the change: The two-stage spotlight ... is not visible in the description.
- asked for, not in the change: The two-pass intent-versus-diff drift check itself is not shown.
- asked for, not in the change: The must_read gate ... is not visible.
- asked for, not in the change: The single sticky pull-request comment ... is not shown.
```

Every one of those four was in the change. A truncation the model cannot see
does not produce a missing answer; it produces a wrong one, in the field whose
whole purpose is to tell an author what their change does that they did not say
it would.

The fix is not a bigger budget - a budget large enough for any change does not
exist. The first pass is now given **the complete file list with its line
counts**, which is cheap and covers the whole change at file granularity, and the
prompt states outright when the diff text below it is a prefix. On the same
change, with the same intent:

```
# eyes-on drift - 2/5

## What the change actually does, described without the intent

- Adds `spotlight`, `drift` and `comment` commands with their supporting modules
  ... `--no-model` returns the ranking alone through `modelOptionsFor` returning
  null so no model is ever invoked.
- Computes intent drift with two separate model calls ... yielding a 1-5 grade
  ... fed into signal S7 as grade-minus-one at weight 0.20 ...
- Adds a gate persisted in new schema/`src/db/gate.ts` ... and adds
  `src/gh/gh.ts`, which routes every `gh` call through an `assertAllowed`
  whole-path allow-list ...

## Drift: 2/5

- **in the change, not asked for:** The drift grade is fed into risk signal S7 at
  weight 0.20, changing the weight sum to 1.20 and how scores are rendered, which
  the intent did not ask for.
```

Three points covering all three areas of the change, and one unrequested item
that is genuinely unrequested - the intent used for the run named the two-pass
check but not its weight in the score. `test/drift.test.ts` now asserts that the
file list is complete, that the cut is stated when there is one, and that a diff
which fits says so rather than warning about a cut that did not happen.

## 9. The clone and the foreign state root were not touched

Captured on adx-worker immediately before the session and again after it, with a
marker file stamped between them:

| Probe | Before | After |
|---|---|---|
| `git status --porcelain` | 0 lines | identical |
| `git for-each-ref` | 369 lines | identical |
| `git config --local --list` | 18 lines | identical |
| `git remote -v` | 4 lines | identical |

**This is a measurement of one session, not a guarantee.** It says the clone was
byte-identical across this sweep; it does not say nothing eyes-on runs can ever
write there. eyes-on's own writes are structural - `gitReadClone()` allow-lists
the subcommands so no git invocation can move a ref, an index entry or a config
value, and every other write goes through `Paths` - but a local agent is a
separate process with the user's environment and eyes-on has no sandbox for it.
What eyes-on controls is the environment it hands that process, which since the
change above is a working directory under its own state root and a prompt on
stdin, with nothing pointing at the clone. The table above is evidence for the
one session; the enforcement claim is deliberately the narrower one.

The stage 0 and stage 1 caveat applies again and was observed again:
`~/.no-mistakes/telemetry-gate.json` is written while eyes-on runs, by
**no-mistakes itself**, whenever any lane on this machine invokes `no-mistakes
axi`. Nothing else under `~/.no-mistakes` changed, and eyes-on's own reads of
that database go through `?mode=ro`.

## Not measured

- **Whether the fragments were the right ones.** Locality measures agreement
  with one reviewer's anchors, not correctness. Whether a reader who followed the
  spotlight caught what mattered is a question for `leaks` over a register filled
  as changes merge - which stage 3 delivers the machinery for and which needs
  the calendar time `docs/stage-3-acceptance.md` section 5 names.
- **The second stage's cost in tokens.** The measurement records wall-clock time
  per pull request, not the model's own accounting.
- **Model agents other than `claude`.** `codex`, `copilot`, `cursor-agent`,
  `opencode`, `pi` and `rovodev` are recognised names that eyes-on **refuses to
  run**: it holds an argument vector only for `claude`, because `claude -p` is
  the only invocation exercised here, and each of the others reads a prompt
  differently. Naming a flag nobody has tried would be a diagnostic promising a
  remedy that does not work, so a repository naming one of them is told exactly
  that and pointed at `model.allow_any_command` in the machine's own config plus
  its own `model.command`. This is a stated narrowing of the approved scope,
  which names `claude` or `codex`; `codex` is not installed on this machine, so
  no invocation for it could be verified. `claude` is also the only default, and
  only when it is actually on PATH.
- **Repositories other than adx-worker and the suite's own fixtures.**
- **Windows and Linux.** As in stages 0 and 1, the session was macOS only.
