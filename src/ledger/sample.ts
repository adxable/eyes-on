/**
 * How much a register of this size is allowed to claim.
 *
 * The report's stage 3 acceptance condition is one sentence long - "at fewer
 * than a hundred merges per channel the report header says the numbers are
 * directional" - and this module is the whole of it, in one place, because two
 * commands say it and a caveat that is written twice is a caveat that stops
 * agreeing with itself.
 *
 * The number is not a convention. The reference measurement is 55 merges at a
 * 28% base leak rate: separating two channels whose rates differ by anything a
 * threshold could be moved for takes on the order of a hundred merges in each
 * of them, so the first reading worth deciding from arrives after roughly three
 * months of the reference repository's merge rate. Below that the table is
 * still worth printing - it is the only way the count ever gets to a hundred -
 * but it is a direction, not a verdict, and the header has to say so where the
 * numbers are read rather than in a footnote.
 */

import type { PopulationState } from './population.js';

/** Merges in a channel below which its rate is directional rather than
 *  decisive. Report section 8, stage 3. */
export const MIN_MERGES_PER_CHANNEL = 100;

/** The base leak rate the hundred was reasoned from, as a percentage. Carried
 *  so the sentence can name what it was derived against rather than assert a
 *  number. */
export const REFERENCE_BASE_RATE_PERCENT = 28;

export interface ChannelSize {
  /** The channel, as the band names it. */
  band: string;
  merges: number;
}

export interface SampleVerdict {
  /** True when every channel carries at least `MIN_MERGES_PER_CHANNEL`. */
  decisive: boolean;
  /** The channels that do not, smallest first. */
  short: ChannelSize[];
  /** The smallest channel, or null when there are no channels at all. */
  smallest: ChannelSize | null;
  /** The one sentence a report header carries. */
  sentence: string;
}

/**
 * What this sample supports, and the sentence that says so.
 *
 * A channel with no merges at all counts as short: a rate over an empty
 * denominator is not a small number, it is no number, and a header that stayed
 * silent about it would let a reader take an absent channel for a clean one.
 *
 * The population is passed beside the channels because an empty table has two
 * causes and they need different sentences. "Nobody has labelled a merge" is
 * answered by running `label`; "the register is full and none of it has had its
 * window yet" is answered by waiting, and is what every new register looks like
 * for a fortnight. Telling the second reader to run the command they have just
 * run twenty times is a sentence stronger than the code, at the first moment
 * they read one.
 *
 * Two commands print this sentence, so it names no command that one of them
 * *is*: pointing a `leaks` reader at `eyes-on leaks` is the same defect wearing
 * the other branch's clothes.
 */
export function sampleVerdict(channels: readonly ChannelSize[], population: PopulationState): SampleVerdict {
  const short = channels
    .filter((channel) => channel.merges < MIN_MERGES_PER_CHANNEL)
    .sort((a, b) => a.merges - b.merges || a.band.localeCompare(b.band));
  const smallest = [...channels].sort((a, b) => a.merges - b.merges || a.band.localeCompare(b.band))[0] ?? null;

  if (channels.length === 0) {
    return { decisive: false, short, smallest, sentence: emptySentence(population) };
  }
  if (short.length === 0) {
    return {
      decisive: true,
      short,
      smallest,
      sentence: `Every channel carries at least ${MIN_MERGES_PER_CHANNEL} merges, which is the size at which two of them can be told apart rather than merely ranked.`,
    };
  }
  const named = short.map((channel) => `\`${channel.band}\` ${channel.merges}`).join(', ');
  const of = channels.length === 1 ? '1 of 1 channel carries' : `${short.length} of ${channels.length} channels carry`;
  return {
    decisive: false,
    short,
    smallest,
    sentence:
      `**These numbers are directional, not decisive.** ${of} fewer than ` +
      `${MIN_MERGES_PER_CHANNEL} merges (${named}). At a base leak rate near ${REFERENCE_BASE_RATE_PERCENT}%, telling two ` +
      `channels apart takes on the order of ${MIN_MERGES_PER_CHANNEL} merges in each of them, so read the table as a ` +
      'direction to keep measuring in and not as a result to move a threshold on.',
  };
}

/** The header when no channel has a merge to compare, which is two states and
 *  not one. */
function emptySentence(population: PopulationState): string {
  if (population.registered === 0) {
    return 'No channel has a merge in the register yet, so there is nothing to compare: run `eyes-on label --pr <n>` after each merge.';
  }
  const named = population.excluded.map((entry) => `${entry.merges} \`${entry.reason}\``).join(', ');
  const waiting = population.excluded.filter((entry) => !entry.permanent).reduce((sum, entry) => sum + entry.merges, 0);
  return (
    `**Nothing here is measurable yet.** The register holds ${population.registered} merge${population.registered === 1 ? '' : 's'} ` +
    `for this repository and none of them is in the denominator${named.length === 0 ? '' : ` (${named})`}, so there is nothing to ` +
    'compare. ' +
    (waiting > 0
      ? `${waiting} of them ${waiting === 1 ? 'joins' : 'join'} the table once ${waiting === 1 ? 'its' : 'their'} window has passed; labelling more merges is still the way the count gets to ${MIN_MERGES_PER_CHANNEL}.`
      : 'Waiting admits none of them: the reasons named are what would have to change.')
  );
}
