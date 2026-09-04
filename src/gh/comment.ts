import type { CheckRow } from '../db/checks.js';
import type { DecisionRow, DriftItemRow, SpotRow } from '../db/gate.js';
import { bandLabel, carriedEvidence, driftProvenanceSentence, unverifiedSentence, type Band } from '../risk/signals.js';

/**
 * The single sticky comment (report Appendix C.4).
 *
 * The marker is a machine contract, not decoration - the same device
 * no-mistakes uses for its attestation (`prsummary.go:25-26`). It is how this
 * command finds the comment it wrote last time instead of adding a second one,
 * and how stage 3's `label` finds the assessment a merged pull request carried.
 * So it is written first, on its own line, and its payload is a single-line
 * JSON object.
 *
 * The comment is written in English like the rest of the CLI's output. The band
 * identifiers inside the marker stay Polish, because they are the report's
 * machine values and translating them would silently break the contract; the
 * human-readable channel name beside them comes from `bandLabel`.
 *
 * What the comment must never be is a second pull-request body. It says what
 * to read and stops. The reason is not tidiness: no-mistakes owns the body and
 * regenerates it on every update, so anything eyes-on wrote there would be lost
 * on the next push - or would overwrite what no-mistakes needs to say.
 */

export const MARKER_PREFIX = '<!-- eyes-on:v1 ';
export const MARKER_SUFFIX = ' -->';

export interface MarkerPayload {
  head_sha: string;
  score: number | null;
  /** The maximum the score was computed against, as it was recorded beside it.
   *  Null on a row written before eyes-on stored one: a denominator invented
   *  here could name a maximum the change was never scored against. */
  score_max: number | null;
  band: string | null;
  /** True when the trusted configuration could not be read, so no hard rule was
   *  evaluated and the band beside it is a lower bound. A reader of this marker
   *  gets the same caveat as a reader of the comment. */
  unverified: boolean;
  decision: string | null;
  check_id: string;
}

export function marker(payload: MarkerPayload): string {
  // Single line, and `--` cannot appear in it: JSON.stringify escapes nothing
  // that would produce one from these fields (two shas, two integers, a
  // boolean, a band identifier and an action), and a marker split across lines
  // would not be found again.
  return `${MARKER_PREFIX}${JSON.stringify(payload)}${MARKER_SUFFIX}`;
}

/**
 * The eyes-on comment among a pull request's comments, or null.
 *
 * Matched on the marker prefix alone, because the payload changes on every
 * recomputation and matching it whole would post a second comment each time.
 * And matched at the **start of the body**, where `renderComment` always writes
 * it, because GitHub's "Quote reply" copies a body verbatim behind a `> `: a
 * reviewer quoting this comment leaves a second body carrying the marker, and
 * updating that one would be a write to somebody else's comment.
 */
export function findMarked<T extends { body: string }>(comments: readonly T[]): T | null {
  return findAllMarked(comments)[0] ?? null;
}

/** Every eyes-on comment on a pull request, by the same rule. There should be
 *  one; a caller that reports how many it found needs to be able to say two. */
export function findAllMarked<T extends { body: string }>(comments: readonly T[]): T[] {
  return comments.filter((comment) => comment.body.startsWith(MARKER_PREFIX));
}

export interface CommentInput {
  /** The recorded assessment. Score, maximum, band and drift grade are four
   *  facts about one check and all four are read from this row: a renderer that
   *  recomputed any of them could publish a number that disagrees with the one
   *  `check` printed. */
  check: CheckRow;
  spots: readonly SpotRow[];
  hits: readonly { glob: string; why: string; files: string[] }[];
  decision: DecisionRow | undefined;
  driftItems: readonly DriftItemRow[];
  /** Normalized signal values, for the one line that says where the score came
   *  from. Only the ones that moved it. */
  signals: readonly { name: string; normalized: number }[];
  /** True when the head this comment describes is not the pull request's head. */
  stale: boolean;
  prHeadSHA: string | null;
}

export function renderComment(input: CommentInput): string {
  const { check } = input;
  const band = (check.band ?? 'auto') as Band;
  const unverified = check.status === 'unverified';
  const outOf = check.score_max === null ? '' : ` of at most ${check.score_max}`;
  const lines: string[] = [
    marker({
      head_sha: check.head_sha,
      score: check.score,
      score_max: check.score_max,
      band: check.band,
      unverified,
      decision: input.decision?.action ?? null,
      check_id: check.id,
    }),
    `**eyes-on - ${check.score ?? 0}${outOf}, channel: ${bandLabel(band)}**`,
    '',
  ];
  // The channel above reads as measured, and on an unverified check the hard
  // rules behind it were never evaluated. This is the surface a reviewer reads.
  if (unverified) {
    lines.push(unverifiedSentence(), '');
  }
  if (check.score_max === null) {
    lines.push(
      'This assessment was recorded before eyes-on stored the maximum a score can reach, so the number above has no denominator here. Re-run `eyes-on check` to record one.',
      '',
    );
  }

  if (input.spots.length > 0) {
    lines.push(`Read ${countWord(input.spots.length)}:`, '');
    for (const [index, spot] of input.spots.entries()) {
      const where = spot.line === null ? spot.file : `${spot.file}:${spot.line}`;
      const category = spot.category ? ` - ${spot.category}` : '';
      lines.push(`${index + 1}. \`${where}\`${category} - ${spot.why ?? ''}`);
    }
    lines.push('');
  } else {
    lines.push(
      'No fragments were ranked for this change. Run `eyes-on spotlight` to fill this in.',
      '',
    );
  }

  const moved = input.signals.filter((signal) => signal.normalized > 0);
  if (moved.length > 0) {
    lines.push(
      `Why ${check.score ?? 0}: ${moved.map((signal) => `${signal.name} ${signal.normalized.toFixed(2)}`).join(' · ')}`,
    );
  }

  for (const hit of input.hits) {
    const decision = input.decision
      ? ` (decision: ${input.decision.action}${input.decision.reason ? ` - ${input.decision.reason}` : ''})`
      : ' (decision: not recorded yet)';
    lines.push(`Hard rule: \`${hit.glob}\` -> full review${hit.why ? ` - ${hit.why}` : ''}${decision}`);
    // One path per line. A space-joined list breaks on `deploy/my values.yaml`,
    // which is exactly the kind of path a hard rule is written for.
    for (const file of hit.files) lines.push(`  - \`${file}\``);
  }

  if (check.drift !== null) {
    const first = input.driftItems.find((item) => item.kind === 'unrequested_in_diff')
      ?? input.driftItems.find((item) => item.kind === 'missing_from_diff');
    lines.push(
      `Intent versus diff: ${check.drift}/5${first ? ` - ${first.item}` : ' - the change and the stated intent agree'}`,
    );
    // Publishing reads the recorded assessment and measures nothing, so the
    // grade above is always one an earlier run took of this same change. The
    // sentence comes from the same place every other surface takes it from.
    lines.push(
      `<sub>${driftProvenanceSentence(carriedEvidence(check))}</sub>`,
    );
  }

  lines.push(
    '',
    `<sub>${check.base_sha.slice(0, 12)}..${check.head_sha.slice(0, 12)}. eyes-on directs attention; nothing here reddens this pull request or holds up a merge, and it does not edit this pull request's body or file a review.${input.stale ? ` **This assessment is of ${check.head_sha.slice(0, 12)}, and the pull request now points at ${(input.prHeadSHA ?? '').slice(0, 12)}.**` : ''}</sub>`,
  );
  return lines.join('\n');
}

function countWord(count: number): string {
  const words = ['no places', 'this one place', 'these two places', 'these three places', 'these four places', 'these five places'];
  return words[count] ?? `these ${count} places`;
}
