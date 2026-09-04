import type { Context } from './context.js';
import { assertMayMutate } from './context.js';
import { flagBool, flagCount, flagString, type ParsedArgs } from './args.js';
import { emitDoc, progress, EXIT_OK, EXIT_ERROR, EXIT_USAGE, UserFacingError } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext, type RiskContext } from './risk-context.js';
import { checkByID, type CheckRow } from '../db/checks.js';
import { hitsFingerprint, recordedDecisionCovering, recordedHits, findPr, type GateHit } from '../db/gate.js';
import { GhError, pullRecord, repoSlug, type PullRecord } from '../gh/gh.js';
import type { UncheckedReason } from '../gh/comment.js';
import { resolveDefaultBranch } from '../rules/trusted.js';
import { linkPull, mergedPulls, type MergeCommit, type PullLink } from '../ledger/link.js';
import { appendRecord, readLedger, LEDGER_VERSION, type CheckSource, type LedgerRecord } from '../ledger/ledger.js';
import {
  classifyMerge,
  exclusionSentence,
  DEFAULT_SINCE_SECONDS,
  DEFAULT_WINDOW_SECONDS,
  type ExclusionReason,
  type MergeClassification,
} from '../ledger/population.js';
import { carriedEvidence, driftProvenanceSentence, unverifiedSentence } from '../risk/signals.js';
import { version } from '../core/version.js';
import type { Database } from '../db/db.js';

/**
 * `eyes-on label --pr <n>` - the register entry a merged change leaves behind.
 *
 * This command is the stage 3 acceptance condition made executable. It
 * reconstructs the chain **change -> pull request -> the commit that landed
 * it** from git and GitHub and nothing else - `src/ledger/link.ts` holds that
 * reasoning - and then writes one append-only line carrying the assessment that
 * change was merged under.
 *
 * Two refusals are the product rather than strictness.
 *
 * **A record is never written without the assessment it describes.** A merged
 * change nobody assessed has no channel, and a register row inventing one would
 * put a change into a comparison it was never in - which is precisely the
 * comparison stage 3 exists to make. So `label` says which assessment it looked
 * for, where, and what to run; and `leaks` reports coverage, so a register that
 * is missing half the merges cannot read as a measurement of all of them.
 *
 * **A disagreement about the merge commit is recorded, not resolved.** When the
 * subject on the default branch and GitHub name different commits, neither is
 * written as the merge commit: the link states what each source said. A row
 * naming one of two contradictory commits is worse than one saying it does not
 * know which, because `leaks` blames against it.
 *
 * `--dry-run` reconstructs everything and writes nothing. It is also how the
 * self-sufficiency measurement is taken: a sweep over a repository's merged
 * pull requests asking this command, rather than a script of its own, is
 * evidence about the product.
 */
export async function labelCommand(context: Context): Promise<number> {
  assertMayMutate(context, 'label');

  const number = parsePr(context.args);
  const dryRun = flagBool(context.args, 'dry-run');

  const risk = riskContext(context, { needRange: false });
  const db = risk.db;
  if (!db) throw new UserFacingError('no eyes-on state database is open', ['Run `eyes-on init` in this repository first']);

  const anchor = resolveDefaultBranch(risk.clonePath, risk.reader, flagString(context.args, 'default-branch'));
  if (!anchor) {
    throw new UserFacingError(`cannot resolve the default branch of ${risk.clonePath}`, [
      'Pass --default-branch <ref> to name the branch pull requests merge into',
      'The register links a change to the commit that landed it on that branch, so it needs to know which branch that is',
    ]);
  }

  const fromGit = mergedPulls(risk.reader, anchor.sha).filter((merge) => merge.number === number);
  const observed = observePull(risk.clonePath, number, fromGit.length > 0);
  const link = linkPull({ number, fromGit, fromGitHub: observed.record, unread: observed.unread });
  progress(context.writers, link.sentence);
  // Read once, so a dry run and a real one cannot report different parent
  // counts for one commit.
  const mergeParents = link.git?.parents ?? parentsFromStore(risk, link.merge_sha);

  const found = findAssessment(db, risk, number, link, flagString(context.args, 'check-id'));
  // Read before anything is appended, so the count is of what was there before
  // this run rather than including the line it is about to write.
  const priorRecords = readLedger(context.paths).records.filter(
    (entry) => entry.repo === risk.repoId && entry.pr === number,
  ).length;

  if (found.check === null) {
    const failure = new UserFacingError(
      `eyes-on has no recorded assessment for #${number}`,
      assessmentHelp(link, found),
      EXIT_ERROR,
    );
    // A dry run reports what a real one would do, and "it would refuse, for
    // this reason" is that report. Exiting non-zero here would make the
    // self-sufficiency sweep - which is exactly a run over changes eyes-on has
    // never assessed - indistinguishable from a broken link.
    if (!dryRun) throw failure;
    emitDoc(
      context.writers,
      context.format,
      unrecordableDoc(number, link, mergeParents, observed.unreadDetail, found, failure),
      () => renderUnrecordable(number, link, failure),
    );
    return EXIT_OK;
  }

  const record = buildRecord({
    db,
    risk,
    number,
    link,
    mergeParents,
    slug: observed.slug,
    check: found.check,
    source: found.source as CheckSource,
  });

  if (!dryRun) {
    appendRecord(context.paths, record);
    progress(context.writers, `appended one line to ${context.paths.ledger}`);
  } else {
    progress(context.writers, 'dry run: nothing was appended to the register');
  }

  const doc = recordedDoc(record, {
    dryRun,
    ledgerPath: context.paths.ledger,
    priorRecords,
    checkCandidates: found.candidates,
    unread: observed.unread,
    unreadDetail: observed.unreadDetail,
    // What `leaks` will do with the row this command has just written, read off
    // the one classifier rather than re-stated here. `label` is the command a
    // person runs per merge, so it is where an unmeasurable row has to be said
    // out loud.
    measurable: classifyMerge(record, {
      reader: risk.reader,
      sinceSeconds: record.recorded_at - DEFAULT_SINCE_SECONDS,
      windowSeconds: DEFAULT_WINDOW_SECONDS,
      nowSeconds: record.recorded_at,
    }),
  });
  emitDoc(context.writers, context.format, doc, () => renderMarkdown(record, doc));
  return EXIT_OK;
}

/* ------------------------------------------------------------------ *
 * The pull request, as GitHub answered - or the fact that it did not.
 * ------------------------------------------------------------------ */

interface Observation {
  slug: string | null;
  record: PullRecord | null;
  unread: UncheckedReason | null;
  /** What gh said, when GitHub answered with an error. Kept out of the recorded
   *  sentence - a rate-limit message is not a durable fact about the change -
   *  and printed where the reader is deciding what to do about it. */
  unreadDetail: string | null;
}

/**
 * Reads the pull request, or says which of the three unread states this is.
 *
 * gh being absent, gh naming no repository and GitHub answering with an error
 * are three different states of the machine - only the first is fixed by
 * installing anything - and they are told apart here where the difference is
 * known. A gh that never reached GitHub is a fourth, and it is not one of the
 * three: it aborts, because a row saying GitHub answered is a claim about a
 * conversation that never happened. None of the three stops the command *when git named the merge commit*:
 * git alone still names it through the `(#N)` subject, and the link records
 * that only one source answered rather than presenting a confirmed chain it
 * never confirmed. Self-sufficiency that aborts on a rate limit half way
 * through a backfill is self-sufficiency on paper.
 *
 * A remote error with no git-side candidate is the one case that still stops:
 * there is nothing to record from either source, and the likeliest cause is a
 * `--pr` that names no pull request, where refusing with gh's own words is the
 * right answer.
 */
function observePull(clonePath: string, number: number, gitNamedMerge: boolean): Observation {
  let slug: string | null;
  try {
    slug = repoSlug(clonePath);
  } catch (error) {
    if (error instanceof GhError && error.spawnFailure === 'missing') {
      return { slug: null, record: null, unread: 'gh-missing', unreadDetail: null };
    }
    if (remoteAnswer(error) && gitNamedMerge) {
      return { slug: null, record: null, unread: 'gh-error', unreadDetail: error.message };
    }
    throw error;
  }
  if (slug === null) return { slug: null, record: null, unread: 'no-repository', unreadDetail: null };
  try {
    return { slug, record: pullRecord(clonePath, slug, number), unread: null, unreadDetail: null };
  } catch (error) {
    if (remoteAnswer(error) && gitNamedMerge) {
      return { slug, record: null, unread: 'gh-error', unreadDetail: error.message };
    }
    throw error;
  }
}

/**
 * Whether GitHub itself answered, as opposed to gh never reaching it.
 *
 * `gh-error` means one thing - gh ran, named the repository, and GitHub replied
 * with a 404, a 403 or a rate limit - and a register line is appended with that
 * sentence inside it. A timeout, a killed process or output too large is a
 * state of this machine and not an answer from GitHub, so filing one under that
 * reason would write a claim into an append-only file that no later run can
 * correct in place. `GhError` already separates the two; the degradation reads
 * that separation rather than treating every failure as the remote kind.
 */
function remoteAnswer(error: unknown): error is GhError {
  return error instanceof GhError && error.kind === 'remote';
}

/**
 * How many parents the recorded merge commit has, read from the object store.
 *
 * The git side already carries the count when a default-branch subject named
 * the commit. When only GitHub did - every row on a repository that merges with
 * `--no-ff` - the commit itself is the remaining source, and the count is what
 * decides whether `leaks` can attribute anything to it. Null when no commit was
 * recorded, or when this clone does not hold it.
 */
function parentsFromStore(risk: RiskContext, mergeSHA: string | null): number | null {
  if (mergeSHA === null) return null;
  return risk.reader.commit(mergeSHA)?.parents.length ?? null;
}

/* ------------------------------------------------------------------ *
 * Which recorded assessment this record is about.
 * ------------------------------------------------------------------ */

interface Found {
  check: CheckRow | null;
  source: CheckSource | null;
  /** Every check row that could have been the one, so a payload can say the
   *  choice was between several rather than the only one there was. */
  candidates: { id: string; head: string; base: string; source: CheckSource }[];
  /** The check id the caller named and eyes-on could not find, when that is
   *  what happened. */
  missingFlag: string | null;
}

/**
 * The assessment this pull request merged under.
 *
 * Four sources, tried in order, and the one that answered is recorded on the
 * row: "which run this line is about" cannot be re-derived from the line
 * afterwards, so it travels with it like every other recorded fact.
 *
 *   - `--check-id`, when the caller named one. A named id that does not exist
 *     stops the command rather than falling through to a guess: the caller
 *     asked for a particular assessment and getting a different one silently is
 *     the failure this whole product is arranged against.
 *   - the check the sticky comment published (`prs.check_id`), which is the
 *     assessment the pull request itself carries.
 *   - a check of the commit GitHub named as the pull request's head.
 *   - a check of the merge commit itself, which is what a sweep over a branch's
 *     history produces - `check --base <parent> --head <merge>`.
 */
function findAssessment(
  db: Database,
  risk: RiskContext,
  number: number,
  link: PullLink,
  flagged: string | null,
): Found {
  const candidates: Found['candidates'] = [];

  const add = (row: CheckRow | undefined, source: CheckSource): void => {
    if (!row || candidates.some((entry) => entry.id === row.id)) return;
    candidates.push({ id: row.id, head: row.head_sha, base: row.base_sha, source });
  };

  if (flagged !== null) {
    const named = checkByID(db, flagged);
    // A check id is a digest of (repository, base, head), so one from another
    // repository is a real row that describes a different repository's change.
    // Recording it here would put that change's score into this repository's
    // register under this repository's id, which no later reader could detect.
    if (!named || named.repo_id !== risk.repoId) {
      return { check: null, source: null, candidates, missingFlag: flagged };
    }
    add(named, 'flag');
    return { check: named, source: 'flag', candidates, missingFlag: null };
  }

  const pr = findPr(db, risk.repoId, number);
  const published = pr?.check_id ? checkByID(db, pr.check_id) : undefined;
  add(published, 'comment');

  const headSHA = link.github?.head_sha ?? null;
  const byHead = headSHA ? newestByHead(db, risk.repoId, headSHA) : undefined;
  add(byHead, 'pr-head');

  const byMerge = link.merge_sha ? newestByHead(db, risk.repoId, link.merge_sha) : undefined;
  add(byMerge, 'merge-commit');

  if (published) return { check: published, source: 'comment', candidates, missingFlag: null };
  if (byHead) return { check: byHead, source: 'pr-head', candidates, missingFlag: null };
  if (byMerge) return { check: byMerge, source: 'merge-commit', candidates, missingFlag: null };
  return { check: null, source: null, candidates, missingFlag: null };
}

/** The newest assessment of a head commit. A head can carry several checks -
 *  one per base it was assessed against - and the newest is the one whose
 *  numbers the pull request last published. */
function newestByHead(db: Database, repoId: string, headSHA: string): CheckRow | undefined {
  return db.get<CheckRow>(
    'SELECT * FROM checks WHERE repo_id = ? AND head_sha = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1',
    repoId,
    headSHA,
  );
}

/** What to do about a pull request eyes-on never assessed. Every line names a
 *  command that works in the state the code has actually established. */
function assessmentHelp(link: PullLink, found: Found): string[] {
  if (found.missingFlag !== null) {
    return [
      `No check with id ${found.missingFlag} is recorded in this state root for this repository`,
      'A check id names an assessment of one repository\'s change; one recorded for another repository is not this one',
      'Run `eyes-on check` on the change and use the `check_id` it prints, or leave --check-id out to let eyes-on find the assessment itself',
    ];
  }
  const lines: string[] = [];
  if (link.git?.parent && link.merge_sha) {
    lines.push(
      `Assess the change as it landed: \`eyes-on check --base ${link.git.parent.slice(0, 12)} --head ${link.merge_sha.slice(0, 12)}\`, then run this again`,
    );
  } else if (link.merge_sha) {
    lines.push(
      `Assess the change as it landed: \`eyes-on check --head ${link.merge_sha.slice(0, 12)}\`, then run this again`,
    );
  } else {
    lines.push(link.sentence);
    lines.push('Without a merge commit there is nothing to assess against; check --pr and --default-branch');
  }
  lines.push(
    'eyes-on records no channel it did not measure: a register row inventing one would put this change into the very comparison stage 3 exists to make',
  );
  lines.push('`eyes-on leaks` reports how many merges on the branch are in the register, so a partial one cannot read as a complete one');
  return lines;
}

/* ------------------------------------------------------------------ *
 * The record.
 * ------------------------------------------------------------------ */

function buildRecord(input: {
  db: Database;
  risk: RiskContext;
  number: number;
  link: PullLink;
  /** Parents of the recorded merge commit, resolved by the caller. */
  mergeParents: number | null;
  slug: string | null;
  check: CheckRow;
  source: CheckSource;
}): LedgerRecord {
  const { db, check, link } = input;
  const named = link.merge_sha === null ? null : link.git;
  const hits: GateHit[] = recordedHits(db, check.id);
  const decision = recordedDecisionCovering(db, check.id);
  const fingerprint = hitsFingerprint(hits);
  const github = link.github;
  const mergeCommit = link.git;

  return {
    v: LEDGER_VERSION,
    recorded_at: Math.floor(Date.now() / 1000),
    repo: input.risk.repoId,
    repo_slug: input.slug,
    pr: input.number,
    pr_url: github?.url ?? null,
    pr_title: github?.title ?? null,
    base_branch: github?.base_ref ?? null,
    merge_sha: link.merge_sha,
    // Only ever the commit this row names. On a disagreement it names neither,
    // and a subject, a parent and a parent count describing the candidate the
    // row rejected would be three facts recorded against something else.
    merge_subject: named?.subject ?? null,
    merge_parent_sha: named?.parent ?? null,
    merge_parents: link.merge_sha === null ? null : input.mergeParents,
    head_sha: github?.head_sha ?? null,
    // GitHub's own merge time when it answered; otherwise the committer date of
    // the commit on the default branch, which is when it landed. Never the
    // author date: for a squash merge that is when the branch's first commit
    // was written, days earlier, and the leak window starts here.
    merged_at: github?.merged_at ?? named?.committed ?? null,
    link: {
      agreement: link.agreement,
      git_merge_sha: mergeCommit?.sha ?? null,
      github_merge_sha: github?.merge_commit_sha ?? null,
      git_candidates: link.git_candidates,
      sentence: link.sentence,
    },
    check_id: check.id,
    check_source: input.source,
    check_base_sha: check.base_sha,
    check_head_sha: check.head_sha,
    score: check.score,
    score_max: check.score_max,
    band: check.band,
    band_from: hits.length > 0 ? 'hard rule' : 'score',
    unverified: check.status === 'unverified',
    hard_rules: hits.map((hit) => ({ glob: hit.glob, file: hit.file })),
    hits_fingerprint: fingerprint,
    decision: decision
      ? {
          action: decision.action,
          reason: decision.reason,
          decided_by: decision.decided_by,
          decided_at: decision.decided_at,
          hits_fingerprint: decision.hits_fingerprint,
          config_sha: decision.config_sha,
          // `recordedDecisionCovering` only returns a decision given against
          // the hits recorded on this check, so this is true whenever there is
          // one at all - and it is written down rather than assumed, because a
          // reader of the register cannot see which query produced the row.
          covers_recorded_hits: decision.hits_fingerprint === fingerprint,
        }
      : null,
    gate: check.status === 'must_read' && !decision ? 'must_read' : 'none',
    drift: check.drift,
    drift_intent: check.drift_intent,
    intent: check.intent,
    config_sha: check.trusted_config_sha,
    eyes_on_version: version(),
  };
}

/* ------------------------------------------------------------------ *
 * Output.
 * ------------------------------------------------------------------ */

interface DocOptions {
  dryRun: boolean;
  ledgerPath: string;
  /** Lines the register already holds for this pull request. Appending a second
   *  is ordinary - a gate answered after the merge, a check re-run - and saying
   *  so is what keeps it from reading as a duplicate. */
  priorRecords: number;
  checkCandidates: Found['candidates'];
  unread: UncheckedReason | null;
  unreadDetail: string | null;
  /** Whether `eyes-on leaks` can measure this row, at the default window and
   *  history span the command runs with. */
  measurable: MergeClassification;
}

function recordedDoc(record: LedgerRecord, options: DocOptions): ToonObject {
  const evidence = carriedEvidence(record);
  return {
    pr: record.pr,
    repo: record.repo_slug,
    dry_run: options.dryRun,
    recorded: !options.dryRun,
    ledger: options.ledgerPath,
    // How the chain was reconstructed, with both sources rather than one
    // answer: the acceptance condition is about this field.
    link: record.link.agreement,
    link_sentence: record.link.sentence,
    git_merge_sha: record.link.git_merge_sha,
    github_merge_sha: record.link.github_merge_sha,
    // How many default-branch commits carried the `(#N)` subject. More than one
    // means the sha above was chosen, and a payload that hid that would be the
    // register choosing between candidates in silence.
    git_candidates: record.link.git_candidates,
    // Null is a disagreement or an absence, never a default: `link` above says
    // which.
    merge_sha: record.merge_sha,
    merge_parent_sha: record.merge_parent_sha,
    merge_parents: record.merge_parents,
    head_sha: record.head_sha,
    merged_at: record.merged_at,
    // Whether GitHub was read at all, and why not when it was not. A run that
    // never called gh knows nothing about the pull request and must not report
    // a value it did not observe.
    github_read: options.unread === null,
    github_unread_reason: options.unread,
    // gh's own words, when GitHub answered with an error. Null in every other
    // state, including the two silences, which have no words of GitHub's.
    github_unread_detail: options.unreadDetail,
    check_id: record.check_id,
    // Which of the four ways found the assessment. It cannot be re-derived
    // from the row afterwards, so it is on the row.
    check_source: record.check_source,
    check_candidates: options.checkCandidates as unknown as ToonValue,
    check_base: record.check_base_sha.slice(0, 12),
    check_head: record.check_head_sha.slice(0, 12),
    score: record.score,
    score_max: record.score_max,
    band: record.band,
    band_from: record.band_from,
    unverified: record.unverified,
    hard_rules: record.hard_rules as unknown as ToonValue,
    hits_fingerprint: record.hits_fingerprint,
    gate: record.gate,
    decision: record.decision?.action ?? null,
    decision_reason: record.decision?.reason ?? null,
    decided_by: record.decision?.decided_by ?? null,
    decision_covers_recorded_hits: record.decision?.covers_recorded_hits ?? null,
    drift: record.drift,
    drift_intent: record.drift_intent,
    // The reason `eyes-on leaks` will keep this row out of the denominator for
    // good, or null. A row inside its window is not reported here: that is the
    // ordinary state of a change that just merged, and it resolves itself.
    excluded_from_leaks: permanentlyUnmeasurable(record, options),
    // The range that classification was made over. `leaks` prints its own
    // `--since` beside the same wording; a reader told to widen a flag has to
    // be told what it is being widened from.
    classified_since: defaultSinceLabel(),
    classified_window: defaultWindowLabel(),
    drift_sentence: driftProvenanceSentence(evidence),
    intent: record.intent,
    exit_code: EXIT_OK,
    help: helpLines(record, options) as ToonValue,
  };
}

/**
 * The reason `leaks` will not count this row at the range it runs over by
 * default, or null.
 *
 * Read off the one classifier rather than re-tested here, and only where no
 * other line already says it: a row naming no merge commit is described by its
 * agreement above, and the case nothing else covers is a row that names one and
 * still cannot be measured. What that state means, and what clears it, is the
 * reason's own text - this decides only whether to print it.
 */
function permanentlyUnmeasurable(record: LedgerRecord, options: DocOptions): ExclusionReason | null {
  if (record.merge_sha === null) return null;
  const verdict = options.measurable;
  return !verdict.eligible && verdict.permanent ? verdict.reason : null;
}

/** The default window and history span, written as the flags that produce
 *  them. `label` reports what `leaks` does when nobody passes either, so the
 *  advice to widen one has to name the value it is widening from. */
function defaultWindowLabel(): string {
  return `${DEFAULT_WINDOW_SECONDS / 86_400}d`;
}

function defaultSinceLabel(): string {
  return `${DEFAULT_SINCE_SECONDS / 86_400}d`;
}

function helpLines(record: LedgerRecord, options: DocOptions): string[] {
  const lines: string[] = [];
  if (options.dryRun) {
    lines.push('Nothing was written: --dry-run reconstructs the chain and appends no line');
  }
  switch (record.link.agreement) {
    case 'agrees':
      break;
    case 'disagrees':
      lines.push(
        'The two sources name different merge commits, so no merge commit was recorded and `eyes-on leaks` has nothing to blame against for this change',
      );
      break;
    case 'git-only':
      lines.push(
        'Only the default-branch subject named a merge commit; nothing confirmed it from GitHub, so the chain is reconstructed from one source',
      );
      break;
    case 'github-only':
      lines.push(
        'Only GitHub named a merge commit; no commit on the default branch carries the `(#N)` subject a squash merge leaves, so the merge may be on another branch',
      );
      break;
    case 'not-merged':
      lines.push('GitHub says this pull request has not merged, so the register row carries no merge commit and no merge time');
      break;
    case 'neither':
      lines.push('Neither source named a merge commit, so `eyes-on leaks` cannot attribute anything to this change');
      break;
  }
  if (record.link.git_candidates > 1) {
    const candidates = `${record.link.git_candidates} commits on the default branch carry a \`(#${record.pr})\` subject`;
    // The count is a fact about the branch and is said in every state. What
    // `leaks` does with the row is the classifier's to say, and the line below
    // says it - so this one claims it only where it is the whole answer.
    lines.push(
      record.merge_sha === null
        ? `${candidates}, and no merge commit was recorded for this row. Check which of them landed this change`
        : options.measurable.eligible
          ? `${candidates}; the newest was recorded as the merge commit, and \`eyes-on leaks\` blames every later fix against that one. Check which of them landed this change`
          : `${candidates}; the newest was recorded as the merge commit. Check which of them landed this change`,
    );
  }
  // A row naming no merge commit is already described by its agreement line
  // above; this is the other case - a row that names one and still cannot be
  // measured, which nothing else on this surface says.
  const unmeasurable = permanentlyUnmeasurable(record, options);
  if (unmeasurable !== null) {
    lines.push(exclusionSentence(unmeasurable, { window: defaultWindowLabel(), since: defaultSinceLabel() }));
  }
  if (options.unread === 'gh-missing') {
    lines.push('Install the GitHub CLI and run `gh auth login` to confirm the merge commit from GitHub as well as from git');
  }
  if (options.unread === 'no-repository') {
    lines.push('gh ran but named no GitHub repository for this clone; run `gh auth status` and `gh repo view` here to see what it reports');
  }
  if (options.unread === 'gh-error') {
    lines.push(
      `GitHub answered gh with an error${options.unreadDetail === null ? '' : ` - ${options.unreadDetail}`}; the chain was reconstructed from the default-branch subject alone, and labelling this pull request again once GitHub answers records what both sources say`,
    );
  }
  if (record.unverified) {
    lines.push(`${unverifiedSentence()} The register row carries that flag, so the channel above is a floor rather than a measurement`);
  }
  if (record.gate === 'must_read') {
    lines.push(
      'This change merged while its gate was still parked: no decision answers the hard rules it hit. The register records that as it is',
    );
  }
  if (options.checkCandidates.length > 1) {
    lines.push(
      `${options.checkCandidates.length} recorded assessments could have described this pull request; the one from \`${record.check_source}\` was used. Pass --check-id to choose another`,
    );
  }
  if (options.priorRecords > 0) {
    lines.push(
      `The register already held ${options.priorRecords} line${options.priorRecords === 1 ? '' : 's'} for this pull request; this ${options.dryRun ? 'would be' : 'is'} another, and every reader takes the newest`,
    );
  }
  lines.push('The register is append-only: labelling this pull request again adds a line and rewrites none');
  lines.push('Run `eyes-on leaks` for the channel table this row feeds, and `eyes-on calibrate` for the threshold sweep over it');
  return lines;
}

function unrecordableDoc(
  number: number,
  link: PullLink,
  mergeParents: number | null,
  unreadDetail: string | null,
  found: Found,
  failure: UserFacingError,
): ToonObject {
  const named = link.merge_sha === null ? null : link.git;
  return {
    pr: number,
    dry_run: true,
    recorded: false,
    // What a run without --dry-run would do. The link may be perfect and the
    // assessment missing, which is exactly the state a self-sufficiency sweep
    // over unassessed history is in, so the two facts are reported apart.
    would_record: false,
    would_record_blocked: failure.message,
    link: link.agreement,
    link_sentence: link.sentence,
    git_merge_sha: link.git?.sha ?? null,
    github_merge_sha: link.github?.merge_commit_sha ?? null,
    git_candidates: link.git_candidates,
    merge_sha: link.merge_sha,
    // Never a fact about a commit this link deliberately does not name, so a
    // dry run and a recorded row describe one pull request the same way.
    merge_parent_sha: named?.parent ?? null,
    merge_parents: link.merge_sha === null ? null : mergeParents,
    head_sha: link.github?.head_sha ?? null,
    merged_at: link.github?.merged_at ?? named?.committed ?? null,
    github_read: link.unread === null,
    github_unread_reason: link.unread,
    github_unread_detail: unreadDetail,
    check_id: null,
    check_source: null,
    check_candidates: found.candidates as unknown as ToonValue,
    exit_code: EXIT_OK,
    help: failure.help as ToonValue,
  };
}

function renderUnrecordable(number: number, link: PullLink, failure: UserFacingError): string {
  const lines = [
    `# eyes-on label - #${number}, nothing to record`,
    '',
    link.sentence,
    '',
    `**${failure.message}.** A dry run reports what a real one would do, and this is it.`,
    '',
  ];
  for (const line of failure.help) lines.push(`- ${line}`);
  return lines.join('\n');
}

function renderMarkdown(record: LedgerRecord, doc: ToonObject): string {
  const lines: string[] = [
    `# eyes-on label - #${record.pr}${record.pr_title ? `, ${record.pr_title}` : ''}`,
    '',
    record.link.sentence,
    '',
    `- assessment \`${record.check_id}\` (found by ${record.check_source}), ${record.check_base_sha.slice(0, 12)}..${record.check_head_sha.slice(0, 12)}`,
    `- ${record.score === null ? 'no score' : `${record.score}${record.score_max === null ? '' : ` of at most ${record.score_max}`}`}, channel \`${record.band ?? 'none'}\` (from ${record.band_from})`,
    `- ${record.hard_rules.length} hard-rule match${record.hard_rules.length === 1 ? '' : 'es'}, gate ${record.gate}${record.decision ? `, decision ${record.decision.action}${record.decision.reason ? ` - ${record.decision.reason}` : ''}` : ''}`,
    `- ${record.drift === null ? 'no drift grade' : `drift ${record.drift}/5`}`,
  ];
  if (record.unverified) {
    lines.push('', `**Unverified.** ${unverifiedSentence()}`);
  }
  lines.push(
    '',
    doc.dry_run === true
      ? `_Nothing was written. A real run would append one line to \`${String(doc.ledger)}\`._`
      : `_One line appended to \`${String(doc.ledger)}\`. The register is append-only._`,
  );
  // Every help line, and in the format this command prints by default. A row
  // `leaks` will not measure, a gate nobody answered and a link only one source
  // confirmed are said here and nowhere else on this surface, so a reader of
  // the default output would otherwise never meet them.
  const help = doc.help as string[];
  if (help.length > 0) {
    lines.push('');
    for (const line of help) lines.push(`- ${line}`);
  }
  return lines.join('\n');
}

/** Validated where the flag is read, so a mistyped number is a usage error with
 *  a remedy rather than a refusal raised inside the gh vector builder - which
 *  would be true about a vector eyes-on cannot write and false about whose
 *  mistake it was. */
function parsePr(args: ParsedArgs): number {
  const number = flagCount(args, 'pr', {
    what: 'a pull request number',
    help: ['Pass the pull request number, for example `eyes-on label --pr 42`'],
    min: 1,
  });
  if (number === null) {
    throw new UserFacingError(
      'label needs --pr <n>',
      ['Pass the pull request number of the merged change, for example `eyes-on label --pr 42`'],
      EXIT_USAGE,
    );
  }
  return number;
}

/** Re-exported for the self-sufficiency sweep, which walks the same list this
 *  command filters. */
export type { MergeCommit };
