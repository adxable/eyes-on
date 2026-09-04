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
  /** What eyes-on saw when it looked at the pull request, or the fact that it
   *  never looked. Staleness is derived from this rather than passed in, so a
   *  caller with no observation cannot hand the renderer a default. */
  pullRequest: PullRequestView;
}

/**
 * The pull request as this run observed it, or the fact that it did not.
 *
 * Every field the output carries about the pull request - its head, how many
 * comments are on it, whether an eyes-on comment is already there, whether the
 * assessment describes the head it now points at - is derived from this one
 * value. `--dry-run` on a host without the GitHub CLI reaches the end of the
 * command having called gh not once, and `false` for staleness there is not a
 * missing observation but a positive claim that the assessment matches a head
 * nobody read.
 *
 * A discriminated union rather than a set of nullable fields, because the next
 * field somebody adds must be unable to default: there is no `head` to read on
 * the unchecked branch at all.
 */
export type PullRequestView =
  | {
      checked: true;
      /** `<owner>/<repo>` as gh named it. */
      slug: string;
      /** The pull request's head commit, or null when gh could not name one. */
      head: string | null;
      /** Every comment on the pull request, from anyone. */
      comments: number;
      /** Those carrying the eyes-on marker. Two would be a defect this number
       *  exists to make visible, so it is counted rather than derived from the
       *  one that gets updated. */
      marked: number;
      existingId: number | null;
      existingUrl: string | null;
    }
  | { checked: false; reason: UncheckedReason };

/** Why a run never read the pull request from GitHub. The three are different
 *  states of the machine: only the first is fixed by installing anything, only
 *  the second is about this clone, and the third is GitHub's own answer. A
 *  surface that collapsed any pair would name a remedy for a state the machine
 *  is not in. */
export type UncheckedReason =
  /** The GitHub CLI is not on PATH. */
  | 'gh-missing'
  /** gh ran and could not name a GitHub repository for this clone - an
   *  unauthenticated gh, or a clone with no GitHub remote. */
  | 'no-repository'
  /** gh ran, named the repository, and GitHub answered with an error: a 404, a
   *  403, a rate limit. Nothing about this machine is broken and nothing about
   *  it needs installing; the same call may succeed later. */
  | 'gh-error';

/**
 * Whether the assessment describes the commit the pull request now points at.
 *
 * Four states, not three, and the two that are not an answer are different
 * things: nobody read the pull request, and somebody read it and GitHub named
 * no head for it. The second needs no failure of gh at all - `--pr <n>` given
 * an issue number lists comments happily and then 404s on the pulls endpoint -
 * so a single "could not read this pull request" would tell a reader the run
 * never looked, beside a payload saying it did.
 *
 * The single place that decides it. A short sha from the API and a full one
 * from the database describe the same commit, so comparing them for equality
 * would report every pull request as stale.
 */
export type Staleness =
  /** Read, and it points at the commit this assessment describes. */
  | { state: 'fresh'; head: string }
  /** Read, and it points somewhere else. */
  | { state: 'stale'; head: string }
  /** Nobody read the pull request. */
  | { state: 'not-observed'; head: null }
  /** Read, and GitHub named no head commit for it. */
  | { state: 'head-unreadable'; head: null };

export function staleness(view: PullRequestView, headSHA: string): Staleness {
  if (!view.checked) return { state: 'not-observed', head: null };
  if (view.head === null) return { state: 'head-unreadable', head: null };
  const moved = !headSHA.startsWith(view.head) && !view.head.startsWith(headSHA);
  return moved ? { state: 'stale', head: view.head } : { state: 'fresh', head: view.head };
}

/** The sentence each state owes a reader of the published comment. */
function stalenessSentence(staleness: Staleness, headSHA: string): string {
  switch (staleness.state) {
    case 'fresh':
      return '';
    case 'stale':
      return ` **This assessment is of ${headSHA.slice(0, 12)}, and the pull request now points at ${staleness.head.slice(0, 12)}.**`;
    case 'not-observed':
      return ' **eyes-on could not read this pull request, so whether it still points at this commit is unchecked.**';
    case 'head-unreadable':
      return ' **eyes-on read this pull request but GitHub named no head commit for it, so whether it still points at this commit is unchecked; the number may belong to an issue rather than a pull request.**';
  }
}

export function renderComment(input: CommentInput): string {
  const { check } = input;
  const stale = staleness(input.pullRequest, check.head_sha);
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
    // Four states, one sentence each. Only `fresh` is silent, because omitting
    // the sentence is itself the claim that the assessment describes the head
    // the pull request has now.
    `<sub>${check.base_sha.slice(0, 12)}..${check.head_sha.slice(0, 12)}. eyes-on directs attention; nothing here reddens this pull request or holds up a merge, and it does not edit this pull request's body or file a review.${stalenessSentence(stale, check.head_sha)}</sub>`,
  );
  return lines.join('\n');
}

function countWord(count: number): string {
  const words = ['no places', 'this one place', 'these two places', 'these three places', 'these four places', 'these five places'];
  return words[count] ?? `these ${count} places`;
}
