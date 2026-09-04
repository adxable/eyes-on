import type { RepoReader } from '../git/reader.js';
import type { LedgerRecord } from './ledger.js';

/**
 * Which registered merges a leak rate may be divided by, decided once.
 *
 * Four surfaces describe this population - the channel table, the sample
 * sentence, the coverage ratio and `label`'s own help - and each of them used
 * to write its own sentence beside the decision instead of reading it. Three
 * review rounds in a row found one of those sentences out of step with the
 * code: a structural exclusion reported as a temporary one, a full register
 * described as an empty one, a row `label` knew was unmeasurable and did not
 * say so about. The shape is the same every time, so the rule lives here and
 * nowhere else.
 *
 * ## One classifier
 *
 * `classifyMerge` is the only place the rule is applied. `measureLeaks` builds
 * its denominator from it, `calibrate` sweeps the population that measurement
 * produced rather than deriving eligibility a second time, and `label` asks it
 * about the row it has just written so the command a person actually runs per
 * merge can say what `leaks` will do with it.
 *
 * ## A reason carries its own words, and its own rank
 *
 * `EXCLUSION_KINDS` holds, beside each reason: whether it is permanent, why
 * blame cannot be attributed, the outlook - what actually clears it, or the
 * explicit fact that nothing does - and how binding it is. Every surface
 * *renders* that text and none of them writes a sentence of its own about a
 * reason. Unifying the decision was not enough: each surface still authored its
 * own words beside it and two of them went wrong in the round after. A reason
 * added later now arrives with its wording attached, so a surface that has
 * never been taught about it still describes it correctly.
 *
 * `permanent` is about the passage of time and nothing else: it is false when a
 * later run over the same range admits the row simply because more time has
 * gone by. Widening `--since`, fetching into a clone or re-labelling a pull
 * request are different states of the machine, not of the clock, so none of
 * them makes a reason non-permanent - and every one of them is a real remedy,
 * which is why `outlook` exists rather than a bare "nothing to be done". Four
 * of the five permanent reasons are cleared by a user action - labelling the
 * pull request again, fetching the default branch, widening `--since` - and one
 * of those, labelling a merge before pulling it, is the commonest flow there
 * is. Only a true merge commit is cleared by nothing at all.
 *
 * ## The order of the tests decides nothing
 *
 * A merge can satisfy several reasons at once, and reporting the first one
 * tested is what let a structural exclusion be dressed as a temporary one, and
 * then - once each reason carried a remedy - let a reason nothing clears be
 * dressed as one a flag clears. `binding` is declared beside the reason and
 * `classifyMerge` returns the most binding applicable one, never the first
 * tested, so the shape of the code below cannot change what a reader is told.
 *
 * The cost rule follows from that rather than trading against it: a reason with
 * a remedy may not be reported until it is known that no more binding reason
 * applies, so the one git read is paid exactly for the rows eyes-on is about to
 * make a promise to. A row that names no commit, and a row whose own parent
 * count already settles the most binding reason of all, are answered without
 * touching the object store.
 */

/** The default leak window and history span (report Appendix C.1). They live
 *  beside the classifier that consumes them, because three commands ask it the
 *  same question and must ask it over the same range. */
export const DEFAULT_WINDOW_SECONDS = 14 * 86_400;
export const DEFAULT_SINCE_SECONDS = 90 * 86_400;

/** Why a registered merge is not in the denominator. */
export type ExclusionReason =
  | 'no merge commit'
  | 'no merge time'
  | 'outside --since'
  | 'merge commit introduces no line'
  | 'commit not in this repository'
  | 'window has not elapsed';

export interface ExclusionKind {
  /**
   * How binding this reason is, smaller being more binding, and a total order
   * over every reason that can hold of one merge at once.
   *
   * The scale is what would have to change for the row to be counted: nothing
   * can (a property of the commit), this run's object store, this run's range,
   * the register row itself, the clock. Declared here rather than implied by
   * the order of the tests, so a reason added later arrives ranked.
   */
  binding: number;
  /** False only when the mere passage of time admits the row on a later run
   *  over this same range. Exactly one reason is in that state. */
  permanent: boolean;
  /** Why blame cannot be attributed, as a clause following a colon. Written so
   *  it reads the same about one row and about twenty. */
  because: string;
  /**
   * What happens next: the remedy that really clears this reason, or the
   * explicit fact that nothing does, with whatever qualifier makes the claim
   * true. This is the only place any surface takes those words from.
   *
   * `{them}`, `{they}`, `{window}` and `{since}` are the four substitutions a
   * renderer makes - "them"/"it", "they"/"it", and the window and history span
   * as the flags would be written. Every sentence here reads correctly under
   * both numbers, and a sentence that tells a reader to widen a range names the
   * range it is widening from.
   */
  outlook: string;
}

export const EXCLUSION_KINDS: Record<ExclusionReason, ExclusionKind> = {
  'no merge commit': {
    // The row names no commit, so every other reason would be about something
    // that does not exist.
    binding: 0,
    permanent: true,
    because: 'no source named a commit to blame onto',
    outlook:
      'Waiting does not change that. Find which commit landed the change - `eyes-on label` prints what each source said - and label the pull request again once both name it.',
  },
  'no merge time': {
    // A property of the register row; writing the row again changes it.
    binding: 4,
    permanent: true,
    because: 'no source named when the change merged, so the window has no start',
    outlook:
      'Waiting does not change that. Label the pull request again with gh reachable, or once the commit that landed it is on the default branch, so a merge time is recorded.',
  },
  'outside --since': {
    // A property of this run's range; a flag changes it.
    binding: 3,
    permanent: true,
    because: 'the merge is older than the period this report covers',
    outlook:
      'No run over `--since {since}` admits {them}, however long anyone waits - but a wider one does: pass a `--since` longer than {since} to count {them}.',
  },
  'merge commit introduces no line': {
    // A property of the commit. Nothing about this run, this clone or this
    // register changes it, which is why nothing may outrank it.
    binding: 1,
    permanent: true,
    because:
      'blame never names a merge commit as introducing a line, so a true merge commit can carry no attributed fix',
    outlook:
      'Nothing clears this one: it is a property of the commit rather than of this run. A change landed as a squash merge produces a row this measurement can use.',
  },
  'commit not in this repository': {
    // A property of this run's object store; a fetch changes it.
    binding: 2,
    permanent: true,
    because: 'the object store this run read does not hold the commit',
    outlook:
      'Waiting does not fetch it. Fetch the default branch into this clone and label the pull request again - labelling a merge before pulling it is the ordinary way to reach this state.',
  },
  'window has not elapsed': {
    // A property of the clock, and the only one waiting undoes.
    binding: 5,
    permanent: false,
    because: 'the whole window every merge in the denominator was given to leak in has not passed yet',
    outlook:
      'This is the one reason time alone undoes: the denominator takes {them} back once {window} has passed since {they} landed.',
  },
};

/**
 * The reason's own words about one row or about several.
 *
 * Every surface calls this rather than writing a sentence beside the flag. The
 * count decides only the pronouns.
 */
export interface ExclusionRange {
  /** The window, as `--window` would be written. */
  window: string;
  /** The history span, as `--since` would be written. */
  since: string;
}

export function exclusionOutlook(
  reason: ExclusionReason,
  options: { plural: boolean; range: ExclusionRange },
): string {
  return EXCLUSION_KINDS[reason].outlook
    .replaceAll('{them}', options.plural ? 'them' : 'it')
    .replaceAll('{they}', options.plural ? 'they' : 'it')
    .replaceAll('{window}', options.range.window)
    .replaceAll('{since}', options.range.since);
}

/** What `leaks` will do with one registered merge, in the reason's own words. */
export function exclusionSentence(reason: ExclusionReason, range: ExclusionRange): string {
  return (
    `\`eyes-on leaks\` leaves this row out of the denominator as \`${reason}\`: ${EXCLUSION_KINDS[reason].because}. ` +
    exclusionOutlook(reason, { plural: false, range })
  );
}

/** A registered merge that is not in the denominator, and which state it is
 *  in. Reported rather than dropped: a population silently narrowed is a rate
 *  nobody can check. */
export interface ExcludedMerge {
  pr: number;
  merge_sha: string | null;
  reason: ExclusionReason;
}

export type MergeClassification =
  | { eligible: true; merge_sha: string; merged_at: number }
  | { eligible: false; reason: ExclusionReason; permanent: boolean; merge_sha: string | null };

export interface ClassifyOptions {
  reader: RepoReader;
  /** Merges at or after this instant are considered. */
  sinceSeconds: number;
  /** How long after a merge a fix still counts as that merge's leak. */
  windowSeconds: number;
  /** Now, as the caller read the clock. Passed in rather than taken here, so
   *  every row of one report is decided against one instant. */
  nowSeconds: number;
}

/**
 * Whether a leak could be attributed to this registered merge at all.
 *
 * Every applicable reason is collected and the most binding one is returned, so
 * no surface can be handed "it comes back in a fortnight" about a row that
 * never does, nor "pass a longer `--since`" about a row a longer `--since`
 * would report differently.
 */
export function classifyMerge(record: LedgerRecord, options: ClassifyOptions): MergeClassification {
  const applicable = applicableReasons(record, options);
  if (applicable.length === 0) {
    // Nothing applied, so both the sha and the time are there.
    return { eligible: true, merge_sha: record.merge_sha as string, merged_at: record.merged_at as number };
  }
  const reason = applicable.reduce((most, next) =>
    EXCLUSION_KINDS[next].binding < EXCLUSION_KINDS[most].binding ? next : most,
  );
  return {
    eligible: false,
    reason,
    permanent: EXCLUSION_KINDS[reason].permanent,
    merge_sha: record.merge_sha,
  };
}

/**
 * Every reason that holds of this merge, in no particular order - the caller
 * ranks them.
 *
 * The object store is read once and only where the answer can still change what
 * is reported: a row naming no commit has nothing to ask about, and a row whose
 * own parent count already establishes the most binding reason of all needs no
 * confirmation of it.
 */
function applicableReasons(record: LedgerRecord, options: ClassifyOptions): ExclusionReason[] {
  const mergeSHA = record.merge_sha;
  if (mergeSHA === null) return ['no merge commit'];

  const reasons: ExclusionReason[] = [];
  if (record.merged_at === null) {
    reasons.push('no merge time');
  } else {
    if (record.merged_at < options.sinceSeconds) reasons.push('outside --since');
    if (record.merged_at + options.windowSeconds > options.nowSeconds) reasons.push('window has not elapsed');
  }

  if (record.merge_parents !== null && record.merge_parents > 1) {
    reasons.push('merge commit introduces no line');
    return reasons;
  }

  // A row written from GitHub's `merge_commit_sha` alone carries no parent
  // count - nothing on the default branch named that commit - and on a
  // repository that merges with `--no-ff` that is every row, which is the
  // repository this exclusion exists for. One read answers both remaining
  // questions: git names no commit it does not hold.
  const commit = options.reader.commit(mergeSHA);
  if (commit === null) reasons.push('commit not in this repository');
  else if ((record.merge_parents ?? commit.parents.length) > 1) reasons.push('merge commit introduces no line');
  return reasons;
}

/** How many rows each reason accounts for, permanent first and largest first
 *  within that, so a reader meets the ones that will not change on their own. */
export interface ExclusionCount {
  reason: ExclusionReason;
  permanent: boolean;
  merges: number;
}

export function countExclusions(excluded: readonly ExcludedMerge[]): ExclusionCount[] {
  const counts = new Map<ExclusionReason, number>();
  for (const entry of excluded) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, merges]) => ({ reason, permanent: EXCLUSION_KINDS[reason].permanent, merges }))
    .sort((a, b) => Number(b.permanent) - Number(a.permanent) || b.merges - a.merges || a.reason.localeCompare(b.reason));
}

/**
 * What the population a report was computed over is made of.
 *
 * `registered` and `measurable` are two different numbers and a header that
 * knows only the second cannot tell "nobody has labelled anything" from "the
 * register is full and none of it is old enough yet" - which is the ordinary
 * first state of the product, not an edge of it.
 */
export interface PopulationState {
  /** Registered merges the report considered. */
  registered: number;
  /** Of those, the ones a rate may be divided by. */
  measurable: number;
  /** Why the rest are not, by count. A surface may name a reason outside
   *  `ExclusionReason` here when it narrows the population further, as
   *  `calibrate` does for a score on another scale. */
  excluded: { reason: string; permanent: boolean; merges: number }[];
}

/**
 * One help line per exclusion reason present, in the reason's own words.
 *
 * Generated rather than written per reason at each surface: a hand-written line
 * beside a flag is the construct that let a structural exclusion be described
 * as a temporary one for a whole review round, and a recoverable one be
 * reported as final in the round after.
 */
export function exclusionHelpLines(excluded: readonly ExcludedMerge[], range: ExclusionRange): string[] {
  return countExclusions(excluded).map((entry) => {
    const many = entry.merges !== 1;
    const head = `${entry.merges} registered merge${many ? 's are' : ' is'} outside the denominator as \`${entry.reason}\`: ${EXCLUSION_KINDS[entry.reason].because}`;
    return `${head}. ${exclusionOutlook(entry.reason, { plural: many, range })}`;
  });
}
