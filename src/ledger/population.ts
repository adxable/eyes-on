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
 * ## Permanence is declared, not positional
 *
 * Every reason carries `permanent` at its definition, and `classifyMerge` asks
 * for a permanent reason before it asks for a pending one. So the order of the
 * tests cannot decide whether an exclusion is described as temporary: a true
 * merge commit that landed this morning is both structurally unattributable and
 * inside its window, and only the first of those is true of it forever. A
 * surface may promise a row returns only when the reason says it does.
 *
 * `permanent` is about the passage of time and nothing else: it is false when a
 * later run over the same range admits the row simply because more time has
 * gone by. Widening `--since`, repairing a clone or re-labelling a pull request
 * are different states of the machine, not of the clock, and none of them makes
 * a reason non-permanent.
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
  /** Why blame cannot be attributed, as a clause following a colon. */
  because: string;
}

export const EXCLUSION_KINDS: Record<ExclusionReason, ExclusionKind> = {
  'no merge commit': {
    permanent: true,
    because: 'nothing named a commit for it, so there is no commit to blame onto',
  },
  'no merge time': {
    permanent: true,
    because: 'nothing named a merge time, so its window has no start',
  },
  'outside --since': {
    permanent: true,
    because: 'it merged before the period this report covers',
  },
  'merge commit introduces no line': {
    permanent: true,
    because:
      'blame never names a merge commit as introducing a line, so no fix can be attributed to a true merge commit rather than a squash',
  },
  'commit not in this repository': {
    permanent: true,
    because: 'the object store this run read does not hold the commit',
  },
  'window has not elapsed': {
    permanent: false,
    because: 'it has not had the whole window every merge in the denominator was given to leak in',
  },
};

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
  if (!options.reader.has(mergeSHA)) return 'commit not in this repository';
  // The parent count is one rule asked of whichever source can answer it. A row
  // written from GitHub's `merge_commit_sha` alone carries none - nothing on
  // the default branch named that commit - and on a repository that merges with
  // `--no-ff` that is every row, which is the repository this exclusion exists
  // for. The guard above has just established the object store holds it.
  const parents = record.merge_parents ?? options.reader.commit(mergeSHA)?.parents.length ?? null;
  if (parents !== null && parents > 1) return 'merge commit introduces no line';
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
 * One help line per exclusion reason present, with the promise the reason
 * actually carries and no other.
 *
 * Generated rather than written per reason at each surface: a hand-written line
 * beside a flag is the construct that let a structural exclusion be described
 * as a temporary one for a whole review round.
 */
export function exclusionHelpLines(excluded: readonly ExcludedMerge[], windowLabel: string): string[] {
  return countExclusions(excluded).map((entry) => {
    const many = entry.merges !== 1;
    const head = `${entry.merges} registered merge${many ? 's are' : ' is'} outside the denominator as \`${entry.reason}\`: ${EXCLUSION_KINDS[entry.reason].because}`;
    return entry.permanent
      ? `${head}, and no later run over this range admits ${many ? 'them' : 'it'} by waiting`
      : `${head}, so ${many ? 'they return' : 'it returns'} to the denominator once ${windowLabel} has passed since ${many ? 'they' : 'it'} landed`;
  });
}
