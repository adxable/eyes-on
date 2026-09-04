import type { Database } from '../db/db.js';
import type { RepoReader } from '../git/reader.js';
import type { RepoConfig } from '../risk/repoconfig.js';
import { attributeFixes, isFixCommit, type FixAttribution } from '../risk/szz.js';
import { mergedPulls } from './link.js';
import type { LedgerRecord } from './ledger.js';
import { sampleVerdict, type ChannelSize, type SampleVerdict } from './sample.js';

/**
 * Leaks per channel (report section 5, P6) - the measure the research report
 * calls the one that cannot be skipped (section 6): without it nobody knows
 * whether letting a change through unread costs anything, and there is no
 * evidence to move a threshold in either direction.
 *
 * A **leak** is a later fix commit whose blame, taken on that fix's parent,
 * names the merge commit of a registered change as the commit that introduced
 * the line the fix removed. That is SZZ-lite pointed backwards: stage 1 asks
 * which *files* keep attracting fixes, and this asks which *merges* do.
 *
 * ## Only the line-level variant exists, and there is no flag for the other one
 *
 * The obvious cheaper variant is the file-level one: "a later fix touched a
 * file this change touched". It is not implemented here and there is no way to
 * ask for it from the CLI - `leaks` refuses the flag names by which somebody
 * might try - and the reason is that it does not measure anything. Its base
 * rate on the reference material is **45-73%**: on a repository where most work
 * lands in a handful of hot files, nearly every merge "leaks" by that
 * definition, so every channel scores nearly the same and the comparison the
 * whole stage exists for produces no signal at all. A measure whose answer is
 * the same for every channel cannot move a threshold, and one that is *cheap*
 * and answers the same for every channel is worse than none, because it looks
 * like evidence.
 *
 * This paragraph is here rather than only in the report because the file
 * variant is a two-line simplification of the code below - drop the blame, keep
 * the path intersection - and it will look like an optimisation to anybody who
 * has not seen the base rate. It is not. Do not add it.
 *
 * ## What blame can and cannot attribute
 *
 * Blame names the commit that introduced a line. A **squash merge** commit is
 * that commit for every line of the change it landed, which is why the link is
 * possible at all. A **true merge commit** introduces no line: blame names the
 * branch commits instead, and no fix can ever be attributed to the merge. Those
 * merges are therefore excluded from the denominator rather than counted as
 * clean - a leak rate whose denominator holds changes that structurally cannot
 * leak is understated by however many of them there are - and every report says
 * how many it excluded and why.
 */

export interface LeakOptions {
  reader: RepoReader;
  /** Opened state database, or null. Only the blame cache; a leak measurement
   *  reads no eyes-on row and writes none. */
  db: Database | null;
  config: RepoConfig;
  /** The register, newest record per pull request, for this repository. */
  records: readonly LedgerRecord[];
  /** Tip of the default branch: where the history walk starts. */
  anchorSHA: string;
  /** Merges and fixes at or after this instant are considered. */
  sinceSeconds: number;
  /** How long after a merge a fix still counts as that merge's leak. */
  windowSeconds: number;
  onProgress?: (message: string) => void;
}

/** One fix commit blamed onto one registered merge. */
export interface Leak {
  pr: number;
  merge_sha: string;
  band: string;
  merged_at: number;
  fix_sha: string;
  fix_subject: string;
  fix_at: number;
  /** Whole days between the merge and the fix, for the reader who wants to see
   *  how much of the window was used. */
  days_after_merge: number;
  /** Lines the fix removed that blame attributed to the merge commit. */
  blamed_lines: number;
}

/** One channel's row of the table the whole stage exists to produce. */
export interface ChannelRow {
  band: string;
  /** Registered merges in this channel that blame could attribute a leak to. */
  merges: number;
  /** How many of them leaked. */
  leaked: number;
  /** `leaked / merges`, or null when the channel has no merge to divide by. */
  rate: number | null;
}

/** A registered merge that is not in the denominator, and which state it is
 *  in. Reported rather than dropped: a population silently narrowed is a rate
 *  nobody can check. */
export interface ExcludedMerge {
  pr: number;
  merge_sha: string | null;
  reason:
    /** No commit was agreed on, so there is nothing to blame onto. */
    | 'no merge commit'
    /** GitHub named no merge time, so the window has no start. */
    | 'no merge time'
    /** It merged before the window this report covers. */
    | 'outside --since'
    /** A true merge commit introduces no line, so blame can never name it. */
    | 'merge commit introduces no line'
    /** The object store this run read does not hold the commit. */
    | 'commit not in this repository';
}

export interface LeaksReport {
  /** There is one variant and this names it, in every payload, so a reader of
   *  the machine output never has to ask which one produced the number. */
  variant: 'line';
  since_seconds: number;
  window_seconds: number;
  /** Merges in the denominator, and how many of them leaked. */
  merges: number;
  leaked: number;
  /** Leaks over merges, or null when there is no merge to divide by. */
  base_rate: number | null;
  channels: ChannelRow[];
  leaks: Leak[];
  excluded: ExcludedMerge[];
  /** Registered merges whose band is a floor because the trusted configuration
   *  could not be read when they were assessed. They are in the table, and they
   *  may be in the wrong channel. */
  unverified: number;
  /** Registered merges that were still parked when they were labelled: nobody
   *  answered the gate before the change landed. */
  parked: number;
  /** How much of the branch's own history the register covers. */
  coverage: { merged_on_branch: number; registered: number };
  /** Fix commits considered, and how many blames the walk had to compute. */
  fixes_considered: number;
  blames_cached: number;
  blames_computed: number;
  sample: SampleVerdict;
}

/**
 * The whole measurement.
 *
 * Note the order: the denominator is decided first, from the register alone,
 * and only then is history walked. A merge that cannot be attributed to is
 * excluded before anything is blamed, so no leak can be counted against a
 * change that is not in the denominator it would be divided by.
 */
export function measureLeaks(options: LeakOptions): LeaksReport {
  const eligible: { record: LedgerRecord; mergeSHA: string; mergedAt: number }[] = [];
  const excluded: ExcludedMerge[] = [];

  for (const record of options.records) {
    const mergeSHA = record.merge_sha;
    if (mergeSHA === null) {
      excluded.push({ pr: record.pr, merge_sha: null, reason: 'no merge commit' });
      continue;
    }
    if (record.merged_at === null) {
      excluded.push({ pr: record.pr, merge_sha: mergeSHA, reason: 'no merge time' });
      continue;
    }
    if (record.merged_at < options.sinceSeconds) {
      excluded.push({ pr: record.pr, merge_sha: mergeSHA, reason: 'outside --since' });
      continue;
    }
    // A true merge commit introduces no line; see the header.
    if (record.merge_parents !== null && record.merge_parents > 1) {
      excluded.push({ pr: record.pr, merge_sha: mergeSHA, reason: 'merge commit introduces no line' });
      continue;
    }
    if (!options.reader.has(mergeSHA)) {
      excluded.push({ pr: record.pr, merge_sha: mergeSHA, reason: 'commit not in this repository' });
      continue;
    }
    eligible.push({ record, mergeSHA, mergedAt: record.merged_at });
  }

  const byMerge = new Map(eligible.map((entry) => [entry.mergeSHA, entry]));
  options.onProgress?.(
    `${eligible.length} registered merges can be attributed to, ${excluded.length} cannot`,
  );

  // History is walked from `--since` and not from the earliest merge: a fix
  // must be inside the reported range to be counted, and a range that quietly
  // widened itself to catch one more fix would report a rate over a period the
  // header does not name.
  const commits = options.reader.history({ sinceSeconds: options.sinceSeconds, until: options.anchorSHA });
  const fixPattern = new RegExp(options.config.fix_commit_pattern);
  const fixes = commits.filter((commit) => isFixCommit(commit, fixPattern));
  options.onProgress?.(`${fixes.length} fix commits in the window, of ${commits.length} commits`);

  const szz = attributeFixes(fixes, {
    reader: options.reader,
    db: options.db,
    fixPattern,
    onProgress: (done, total) => {
      if (done === 1 || done === total || done % 25 === 0) options.onProgress?.(`blaming fixes: ${done}/${total}`);
    },
  });

  const leaks: Leak[] = [];
  for (const attribution of szz.attributions) {
    for (const [introducer, lines] of Object.entries(attribution.introducers)) {
      const merge = byMerge.get(introducer);
      if (!merge) continue;
      // A merge cannot be its own leak, and a fix that predates the merge it
      // blames into is a clock disagreeing with itself rather than a leak.
      if (attribution.sha === merge.mergeSHA) continue;
      const elapsed = attribution.timestamp - merge.mergedAt;
      if (elapsed < 0 || elapsed > options.windowSeconds) continue;
      leaks.push({
        pr: merge.record.pr,
        merge_sha: merge.mergeSHA,
        band: bandOf(merge.record),
        merged_at: merge.mergedAt,
        fix_sha: attribution.sha,
        fix_subject: attribution.subject,
        fix_at: attribution.timestamp,
        days_after_merge: Math.floor(elapsed / 86_400),
        blamed_lines: lines,
      });
    }
  }

  const channels = channelRows(eligible.map((entry) => entry.record), leaks);
  const leakedMerges = new Set(leaks.map((leak) => leak.merge_sha));
  // Both sides of the coverage ratio are counted over the same period. A
  // registered count taken over the whole register against a branch count taken
  // over the window would report coverage above 100% on a repository older than
  // `--since`, which reads as "more than everything" rather than as two
  // different questions.
  const coverage = {
    merged_on_branch: mergedPulls(options.reader, options.anchorSHA, { sinceSeconds: options.sinceSeconds }).length,
    registered: options.records.filter(
      (record) => record.merged_at !== null && record.merged_at >= options.sinceSeconds,
    ).length,
  };

  return {
    variant: 'line',
    since_seconds: options.sinceSeconds,
    window_seconds: options.windowSeconds,
    merges: eligible.length,
    leaked: leakedMerges.size,
    base_rate: eligible.length === 0 ? null : leakedMerges.size / eligible.length,
    channels,
    leaks: leaks.sort((a, b) => b.fix_at - a.fix_at),
    excluded,
    unverified: eligible.filter((entry) => entry.record.unverified).length,
    parked: eligible.filter((entry) => entry.record.gate === 'must_read').length,
    coverage,
    fixes_considered: fixes.length,
    blames_cached: szz.cached,
    blames_computed: szz.computed,
    sample: sampleVerdict(channels.map((row): ChannelSize => ({ band: row.band, merges: row.merges }))),
  };
}

/** The channel a record belongs to. A record with no band was assessed and
 *  scored nothing the band could be read from, so it is its own channel rather
 *  than being folded into `auto` - which would be a claim that nobody made. */
export function bandOf(record: LedgerRecord): string {
  return record.band ?? 'unbanded';
}

/**
 * One row per channel present in the denominator.
 *
 * Channels are taken from the records rather than from a fixed list of the
 * three bands, because a repository may set thresholds that never produce one
 * of them, and a row of zeroes for a channel nothing was ever in reads as a
 * measurement of it.
 */
export function channelRows(records: readonly LedgerRecord[], leaks: readonly Leak[]): ChannelRow[] {
  const leakedByMerge = new Set(leaks.map((leak) => leak.merge_sha));
  const rows = new Map<string, ChannelRow>();
  for (const record of records) {
    const band = bandOf(record);
    const row = rows.get(band) ?? { band, merges: 0, leaked: 0, rate: null };
    row.merges += 1;
    if (record.merge_sha !== null && leakedByMerge.has(record.merge_sha)) row.leaked += 1;
    rows.set(band, row);
  }
  return [...rows.values()]
    .map((row) => ({ ...row, rate: row.merges === 0 ? null : row.leaked / row.merges }))
    .sort((a, b) => a.band.localeCompare(b.band));
}

/** Every fix attribution, for a caller that wants the raw material. Exported
 *  so a test can prove the blame is what decides a leak, rather than a path
 *  intersection wearing its name. */
export type { FixAttribution };
