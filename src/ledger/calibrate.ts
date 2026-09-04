import { bandFor, type Band } from '../risk/signals.js';
import type { LedgerRecord } from './ledger.js';
import type { Leak } from './leaks.js';
import { countExclusions, type ExcludedMerge, type PopulationState } from './population.js';
import { sampleVerdict, type ChannelSize, type SampleVerdict } from './sample.js';

/**
 * `calibrate` - what each pair of thresholds would have caught, and what it
 * would have let through (report section 5, P6).
 *
 * The sweep is arithmetic over the register and nothing else: for every
 * candidate pair it re-bands the merges that are already recorded, and counts
 * how many of each channel leaked. There is no model in it, no re-assessment,
 * and no new git read - the scores were computed once, when the change was
 * assessed, and re-deriving them here would let `calibrate` disagree with the
 * comment that was published on the pull request.
 *
 * Four things decide whether the sweep means anything, and each is enforced
 * rather than assumed.
 *
 * **The sweep runs over the population the leaks were measured over.** The
 * numerator comes from `measureLeaks`, which admits a merge to the denominator
 * only if a leak could have been attributed to it - it merged inside `--since`,
 * both sources agreed on a commit, that commit is a squash merge this object
 * store holds, and its window has elapsed. Banding the whole register instead
 * would divide those leaks by a larger population and understate every rate,
 * and would print channel sizes disagreeing with the ones `leaks` prints for
 * the same register. So `LeaksReport.eligible` is what comes in here - the
 * measured population itself, not a second copy of the rule that produced it -
 * and the rows it left out are counted with their reasons.
 *
 * **A score is only comparable to a threshold under the weights it was computed
 * with.** `score_max` is recorded beside every score for exactly this reason,
 * and a register holding two different maxima holds two different scales. The
 * sweep runs over one scale - the one most of the register is on - and reports
 * the rows it set aside rather than mixing them.
 *
 * **A band a hard rule forced does not move when a threshold moves.** Those
 * changes are `pelna` at every candidate pair, so they are held there by
 * `band_from` rather than re-banded from their score. Sweeping them would
 * report a channel assignment the product would never produce.
 *
 * **Nothing is recommended that the sample can support.** With fewer than a
 * hundred merges in a channel the rows are a direction, and `sample` carries
 * the sentence that says so. When no merge leaked at all, no pair is
 * distinguishable from any other on the evidence and the sweep says that
 * instead of ranking rows by a tie.
 */

/** Candidate thresholds are tried at this spacing. Five points is the finest
 *  step a register of a few hundred merges can tell apart at all: a one-point
 *  grid would produce twenty times the rows and the same handful of distinct
 *  channel assignments. */
export const GRID_STEP = 5;

export interface CalibrateOptions {
  /** `LeaksReport.eligible`: the merges the leak counts were divided by. */
  records: readonly LedgerRecord[];
  leaks: readonly Leak[];
  /** `LeaksReport.excluded`: the register rows that measurement left out, so
   *  the narrowing is reported here too rather than being invisible on this
   *  surface. */
  excluded: readonly ExcludedMerge[];
  /** The thresholds in force now, so the sweep can say where the repository
   *  stands before it says where it could stand. */
  current: { read_fragments: number; full_review: number };
  /** The maximum the current weights produce. Records scored under another one
   *  are set aside; this is the scale the grid runs on. */
  scoreMax: number;
}

export interface ChannelCount {
  band: Band;
  merges: number;
  leaked: number;
  rate: number | null;
}

export interface GridRow {
  read_fragments: number;
  full_review: number;
  channels: ChannelCount[];
  /** Share of merges this pair would have sent to a human, in either of the two
   *  reading channels. The cost side of the trade. */
  read_share: number;
  /** Merges the `auto` channel would have carried, and how many of them
   *  leaked. The risk side of the trade, and the number Meta calibrates on. */
  auto_merges: number;
  auto_leaked: number;
  auto_rate: number | null;
  /** True when this is the pair the repository uses now. */
  current: boolean;
}

export interface CalibrateReport {
  /** Records the sweep ran over. */
  merges: number;
  /** Of those, how many leaked at all. Nothing can be calibrated on zero. */
  leaked: number;
  score_max: number;
  /** Records set aside because they were scored under a different maximum, with
   *  the maximum each was on. */
  other_scales: { score_max: number | null; merges: number }[];
  /** Records held at `pelna` by a hard rule at every candidate pair. */
  rule_forced: number;
  /** Records carrying no score at all, which no threshold can band. */
  unscored: number;
  /** Register rows outside the leak denominator, with the reason each was left
   *  out. The sweep never saw them, and a reader of the channel sizes above is
   *  told how many rows that is. */
  outside_denominator: { reason: ExcludedMerge['reason']; merges: number }[];
  current: GridRow | null;
  rows: GridRow[];
  /** The pair this history points at, or null when it points at none. Never
   *  called a recommendation: `sample` says what the register can support. */
  candidate: GridRow | null;
  /** Why there is no candidate, when there is none. */
  candidate_blocked: string | null;
  sample: SampleVerdict;
}

/**
 * Runs the sweep.
 *
 * The population is fixed first - one scale, scored records only - and every
 * row is computed over that same population, so two rows are comparable with
 * each other and both are comparable with the current one.
 */
export function calibrate(options: CalibrateOptions): CalibrateReport {
  const leakedMerges = new Set(options.leaks.map((leak) => leak.merge_sha));
  const scaled = options.records.filter((record) => record.score_max === options.scoreMax);
  const otherScales = countScales(options.records.filter((record) => record.score_max !== options.scoreMax));
  const scored = scaled.filter((record) => record.score !== null);
  const unscored = scaled.length - scored.length;

  const population = scored.map((record) => ({
    score: record.score as number,
    /** A hard rule holds this at `pelna` whatever the thresholds say. */
    forced: record.band_from === 'hard rule',
    leaked: record.merge_sha !== null && leakedMerges.has(record.merge_sha),
  }));

  const rowFor = (read: number, full: number): GridRow => {
    const counts = new Map<Band, { merges: number; leaked: number }>();
    for (const entry of population) {
      const band: Band = entry.forced ? 'pelna' : bandFor(entry.score, { read_fragments: read, full_review: full });
      const cell = counts.get(band) ?? { merges: 0, leaked: 0 };
      cell.merges += 1;
      if (entry.leaked) cell.leaked += 1;
      counts.set(band, cell);
    }
    const channels: ChannelCount[] = (['auto', 'wskazane', 'pelna'] as Band[]).map((band) => {
      const cell = counts.get(band) ?? { merges: 0, leaked: 0 };
      return { band, merges: cell.merges, leaked: cell.leaked, rate: cell.merges === 0 ? null : cell.leaked / cell.merges };
    });
    const auto = channels[0] as ChannelCount;
    const read_share = population.length === 0 ? 0 : (population.length - auto.merges) / population.length;
    return {
      read_fragments: read,
      full_review: full,
      channels,
      read_share,
      auto_merges: auto.merges,
      auto_leaked: auto.leaked,
      auto_rate: auto.rate,
      current: read === options.current.read_fragments && full === options.current.full_review,
    };
  };

  const rows: GridRow[] = [];
  for (let read = GRID_STEP; read <= options.scoreMax - GRID_STEP; read += GRID_STEP) {
    for (let full = read + GRID_STEP; full <= options.scoreMax; full += GRID_STEP) {
      rows.push(rowFor(read, full));
    }
  }
  // The pair in force may not sit on the grid - a repository sets whatever it
  // likes - so it is computed on its own and marked, rather than looked up.
  const currentRow = rowFor(options.current.read_fragments, options.current.full_review);

  const leaked = population.filter((entry) => entry.leaked).length;
  const chosen = chooseCandidate(rows, currentRow, leaked);

  return {
    merges: population.length,
    leaked,
    score_max: options.scoreMax,
    other_scales: otherScales,
    rule_forced: population.filter((entry) => entry.forced).length,
    unscored,
    outside_denominator: countExclusions(options.excluded).map((entry) => ({ reason: entry.reason, merges: entry.merges })),
    current: currentRow,
    rows,
    candidate: chosen.row,
    candidate_blocked: chosen.blocked,
    // An empty sweep has no channels at all, and saying "three channels carry
    // fewer than a hundred merges" about it would describe a table that does
    // not exist. The population beside it is what tells an empty register from
    // a full one whose rows are not measurable yet - the ordinary first state
    // of this product, which `leaks` and this command must describe alike.
    sample: sampleVerdict(
      population.length === 0
        ? []
        : currentRow.channels.map((channel): ChannelSize => ({ band: channel.band, merges: channel.merges })),
      populationState(options, population.length, unscored, otherScales),
    ),
  };
}

/**
 * The pair this history points at, or the reason it points at none.
 *
 * The objective is the research report's: hold the cost of the automatic
 * channel at or below what it costs today, and pay as little human reading as
 * possible for that. So among the rows whose `auto` channel leaks no more often
 * than the current one does, the one that sends the fewest changes to a human
 * wins.
 *
 * **A pair that ties with the one in force is not a candidate.** The objective
 * reads two numbers - what the `auto` channel leaks and how much reading is
 * paid - and neither of them can tell `wskazane` from `pelna`, so every pair
 * that only moves the boundary between the two reading channels scores exactly
 * what the current pair scores. Ranking those by anything else produced a
 * "candidate" of 35/120 beside a current 35/65 on the reference register:
 * arithmetically tied, and an instruction to abolish the full-review channel
 * for no measured gain. A tie means this history argues for no change, and the
 * report says that instead.
 *
 * Three states produce no candidate at all and each is named rather than filled
 * in: a register in which nothing leaked cannot rank two pairs on leaks; a
 * register whose current `auto` channel is empty gives the comparison no
 * baseline to hold; and a grid on which nothing beats the pair in force is a
 * grid arguing for the pair in force.
 */
function chooseCandidate(
  rows: readonly GridRow[],
  current: GridRow,
  leaked: number,
): { row: GridRow | null; blocked: string | null } {
  if (leaked === 0) {
    return {
      row: null,
      blocked:
        'No registered merge leaked inside the window, so every pair of thresholds costs the same on this evidence and none of them can be argued for. Keep labelling merges and run this again.',
    };
  }
  if (current.auto_rate === null) {
    return {
      row: null,
      blocked:
        'The current thresholds put no merge in the `auto` channel, so there is no leak rate to hold a candidate at or below. Nothing here can argue for a different pair.',
    };
  }
  const ceiling = current.auto_rate;
  const eligible = rows.filter(
    (row) => row.auto_rate !== null && row.auto_rate <= ceiling && row.read_share < current.read_share,
  );
  if (eligible.length === 0) {
    // Whether anything on the grid tied with the pair in force decides which
    // sentence is true. "Nothing beat it" and "several pairs matched it and
    // none of them is a different answer" are different states of the register,
    // and only the second is the one the wskazane/pelna blindness produces.
    const tied = rows.filter(
      (row) => row.auto_rate !== null && row.auto_rate <= ceiling && row.read_share === current.read_share && !row.current,
    );
    return {
      row: null,
      blocked:
        `No pair on the grid keeps the \`auto\` channel at or below its current leak rate of ${percent(ceiling)} ` +
        `while sending less than the current ${percent(current.read_share)} of merges to a human, so this history ` +
        'argues for no change.' +
        (tied.length === 0
          ? ''
          : ` ${tied.length} pairs score exactly what the pair in force scores: the two numbers this sweep ranks on` +
            ' cannot tell `wskazane` from `pelna`, so a pair that only moves the boundary between the two reading' +
            ' channels is not a different answer.'),
    };
  }
  // Among the rows that genuinely beat the pair in force, the least reading;
  // and among those, the smallest move from where the repository stands, so a
  // tie is not broken by an arbitrary end of the grid.
  const move = (row: GridRow): number =>
    Math.abs(row.read_fragments - current.read_fragments) + Math.abs(row.full_review - current.full_review);
  const best = [...eligible].sort(
    (a, b) => a.read_share - b.read_share || move(a) - move(b) || a.read_fragments - b.read_fragments,
  )[0] as GridRow;
  return { row: best, blocked: null };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * What the sweep ran over, and everything it did not, in the shape every
 * surface reads.
 *
 * The leak exclusions come from the measurement rather than being re-derived,
 * and the sweep's own two narrowings are named beside them: a score under other
 * weights and a row with no score are permanent in the same sense - no amount
 * of waiting puts them on this grid.
 */
function populationState(
  options: CalibrateOptions,
  measurable: number,
  unscored: number,
  otherScales: { score_max: number | null; merges: number }[],
): PopulationState {
  const excluded: PopulationState['excluded'] = [...countExclusions(options.excluded)];
  const onOtherScales = otherScales.reduce((sum, scale) => sum + scale.merges, 0);
  if (onOtherScales > 0) excluded.push({ reason: 'scored on another scale', permanent: true, merges: onOtherScales });
  if (unscored > 0) excluded.push({ reason: 'no score recorded', permanent: true, merges: unscored });
  return {
    registered: options.records.length + options.excluded.length,
    measurable,
    excluded,
  };
}

/** How many records sit on each other scale, so a reader can see whether the
 *  set-aside group is one stale row or half the register. */
function countScales(records: readonly LedgerRecord[]): { score_max: number | null; merges: number }[] {
  const counts = new Map<number | null, number>();
  for (const record of records) counts.set(record.score_max, (counts.get(record.score_max) ?? 0) + 1);
  return [...counts.entries()]
    .map(([score_max, merges]) => ({ score_max, merges }))
    .sort((a, b) => (a.score_max ?? -1) - (b.score_max ?? -1));
}
