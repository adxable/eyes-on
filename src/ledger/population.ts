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
 * ## A reason carries its own words
 *
 * `EXCLUSION_KINDS` holds, beside each reason: whether it is permanent, why
 * blame cannot be attributed, and the outlook - what actually clears it, or the
 * explicit fact that nothing does. Every surface *renders* that text and none
 * of them writes a sentence of its own about a reason. Unifying the decision
 * was not enough: each surface still authored its own words beside it and two
 * of them went wrong in the round after. A reason added later now arrives with
 * its wording attached, so a surface that has never been taught about it still
 * describes it correctly.
 *
 * `permanent` is about the passage of time and nothing else: it is false when a
 * later run over the same range admits the row simply because more time has
 * gone by. Widening `--since`, fetching into a clone or re-labelling a pull
 * request are different states of the machine, not of the clock, so none of
 * them makes a reason non-permanent - and every one of them is a real remedy,
 * which is why `outlook` exists rather than a bare "nothing to be done". Two of
 * the five permanent reasons are cleared by an ordinary user action, and one of
 * those - labelling a merge before pulling it - is the commonest flow there is.
 *
 * `classifyMerge` asks for a permanent reason before it asks for a pending one,
 * so the order of the tests cannot decide whether an exclusion is described as
 * temporary: a true merge commit that landed this morning is both structurally
 * unattributable and inside its window, and only the first of those is true of
 * it forever.
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
   * `{them}`, `{they}` and `{window}` are the three substitutions a renderer
   * makes - "them"/"it", "they"/"it" and the window as the flag would be
   * written. Every sentence here reads correctly under both numbers.
   */
  outlook: string;
}

export const EXCLUSION_KINDS: Record<ExclusionReason, ExclusionKind> = {
  'no merge commit': {
    permanent: true,
    because: 'no source named a commit to blame onto',
    outlook:
      'Waiting does not change that. Find which commit landed the change - `eyes-on label` prints what each source said - and label the pull request again once both name it.',
  },
  'no merge time': {
    permanent: true,
    because: 'no source named when the change merged, so the window has no start',
    outlook:
      'Waiting does not change that. Label the pull request again with gh reachable, or once the commit that landed it is on the default branch, so a merge time is recorded.',
  },
  'outside --since': {
    permanent: true,
    because: 'the merge is older than the period this report covers',
    outlook:
      'No run over this `--since` admits {them}, however long anyone waits - but a wider one does: pass a longer `--since` to count {them}.',
  },
  'merge commit introduces no line': {
    permanent: true,
    because:
      'blame never names a merge commit as introducing a line, so a true merge commit can carry no attributed fix',
    outlook:
      'Nothing clears this one: it is a property of the commit rather than of this run. A change landed as a squash merge produces a row this measurement can use.',
  },
  'commit not in this repository': {
    permanent: true,
    because: 'the object store this run read does not hold the commit',
    outlook:
      'Waiting does not fetch it. Fetch the default branch into this clone and label the pull request again - labelling a merge before pulling it is the ordinary way to reach this state.',
  },
  'window has not elapsed': {
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
export function exclusionOutlook(reason: ExclusionReason, options: { plural: boolean; windowLabel: string }): string {
  return EXCLUSION_KINDS[reason].outlook
    .replaceAll('{them}', options.plural ? 'them' : 'it')
    .replaceAll('{they}', options.plural ? 'they' : 'it')
    .replaceAll('{window}', options.windowLabel);
}

/** What `leaks` will do with one registered merge, in the reason's own words. */
export function exclusionSentence(reason: ExclusionReason, windowLabel: string): string {
  return (
    `\`eyes-on leaks\` leaves this row out of the denominator as \`${reason}\`: ${EXCLUSION_KINDS[reason].because}. ` +
    exclusionOutlook(reason, { plural: false, windowLabel })
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
 * A permanent reason wins over a pending one wherever both hold, so no surface
 * can be handed "it comes back in a fortnight" about a row that never does.
 */
export function classifyMerge(record: LedgerRecord, options: ClassifyOptions): MergeClassification {
  const permanent = permanentExclusion(record, options);
  if (permanent !== null) return { eligible: false, reason: permanent, permanent: true, merge_sha: record.merge_sha };

  const pending = pendingExclusion(record, options);
  if (pending !== null) return { eligible: false, reason: pending, permanent: false, merge_sha: record.merge_sha };

  // Both guards above have already established these.
  return { eligible: true, merge_sha: record.merge_sha as string, merged_at: record.merged_at as number };
}

/** Every reason here is `permanent: true` in the table above; nothing in this
 *  function may return one that is not. */
function permanentExclusion(record: LedgerRecord, options: ClassifyOptions): ExclusionReason | null {
  const mergeSHA = record.merge_sha;
  if (mergeSHA === null) return 'no merge commit';
  if (record.merged_at === null) return 'no merge time';
  if (record.merged_at < options.sinceSeconds) return 'outside --since';
  // One read answers both remaining questions: git names no commit it does not
  // hold, so a null here is the same fact `cat-file -e` would have reported, at
  // one spawn per row rather than two.
  const commit = options.reader.commit(mergeSHA);
  if (commit === null) return 'commit not in this repository';
  // The parent count is one rule asked of whichever source can answer it. A row
  // written from GitHub's `merge_commit_sha` alone carries none - nothing on
  // the default branch named that commit - and on a repository that merges with
  // `--no-ff` that is every row, which is the repository this exclusion exists
  // for.
  const parents = record.merge_parents ?? commit.parents.length;
  if (parents > 1) return 'merge commit introduces no line';
  return null;
}

/** Reasons the clock alone undoes. Every one is `permanent: false`. */
function pendingExclusion(record: LedgerRecord, options: ClassifyOptions): ExclusionReason | null {
  if (record.merged_at !== null && record.merged_at + options.windowSeconds > options.nowSeconds) {
    return 'window has not elapsed';
  }
  return null;
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
export function exclusionHelpLines(excluded: readonly ExcludedMerge[], windowLabel: string): string[] {
  return countExclusions(excluded).map((entry) => {
    const many = entry.merges !== 1;
    const head = `${entry.merges} registered merge${many ? 's are' : ' is'} outside the denominator as \`${entry.reason}\`: ${EXCLUSION_KINDS[entry.reason].because}`;
    return `${head}. ${exclusionOutlook(entry.reason, { plural: many, windowLabel })}`;
  });
}
