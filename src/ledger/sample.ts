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
 */
export function sampleVerdict(channels: readonly ChannelSize[]): SampleVerdict {
  const short = channels
    .filter((channel) => channel.merges < MIN_MERGES_PER_CHANNEL)
    .sort((a, b) => a.merges - b.merges || a.band.localeCompare(b.band));
  const smallest = [...channels].sort((a, b) => a.merges - b.merges || a.band.localeCompare(b.band))[0] ?? null;

  if (channels.length === 0) {
    return {
      decisive: false,
      short,
      smallest,
      sentence:
        'No channel has a merge in the register yet, so there is nothing to compare: run `eyes-on label --pr <n>` after each merge.',
    };
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
