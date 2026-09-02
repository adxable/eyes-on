import type { CheckRow } from '../db/checks.js';
import type { DecisionRow, DriftItemRow, SpotRow } from '../db/gate.js';
import { bandLabel, type Band } from '../risk/signals.js';

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
  score_max: number;
  band: string | null;
  decision: string | null;
  check_id: string;
}

export function marker(payload: MarkerPayload): string {
  // Single line, and `--` cannot appear in it: JSON.stringify escapes nothing
  // that would produce one from these fields (two shas, two integers, a band
  // identifier and an action), and a marker split across lines would not be
  // found again.
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
  return comments.find((comment) => comment.body.startsWith(MARKER_PREFIX)) ?? null;
}

export interface CommentInput {
  check: CheckRow;
  scoreMax: number;
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
  const lines: string[] = [
    marker({
      head_sha: check.head_sha,
      score: check.score,
      score_max: input.scoreMax,
      band: check.band,
      decision: input.decision?.action ?? null,
      check_id: check.id,
    }),
    `**eyes-on - ${check.score ?? 0} of at most ${input.scoreMax}, channel: ${bandLabel(band)}**`,
    '',
  ];

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
  }

  lines.push(
    '',
    `<sub>${check.base_sha.slice(0, 12)}..${check.head_sha.slice(0, 12)}. eyes-on directs attention; it blocks nothing, does not edit this pull request's body, and files no review.${input.stale ? ` **This assessment is of ${check.head_sha.slice(0, 12)}, and the pull request now points at ${(input.prHeadSHA ?? '').slice(0, 12)}.**` : ''}</sub>`,
  );
  return lines.join('\n');
}

function countWord(count: number): string {
  const words = ['no places', 'this one place', 'these two places', 'these three places', 'these four places', 'these five places'];
  return words[count] ?? `these ${count} places`;
}
