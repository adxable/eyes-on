import type { Candidate } from './rank.js';

/**
 * Every prompt eyes-on sends, in one file.
 *
 * Two of them are the anti-anchoring pair the research report describes
 * (section 5.4): the first is shown the diff and *not* the intent, the second
 * is shown that description and the intent but never the diff. Splitting them
 * is the whole mechanism - a model that can see both at once reads the diff
 * through the intent and reports agreement it has not checked. Keeping the two
 * texts next to each other is what makes it obvious when an edit to one would
 * quietly leak the other's input.
 *
 * The style prohibition in the spotlight prompt is not politeness. Measured
 * against 18,000 human review comments, AI reviewers under-report correctness
 * by 42.6% and security by 89.5% while over-reporting style by 328% (research
 * report section 1.3). Without an explicit instruction the second stage
 * reorders twelve genuine candidates by how they are formatted.
 */

/** Categories the second stage may use, in the priority the taxonomy gives
 *  them: correctness 44.4%, maintainability 19.2%, security 19.1%. */
export const CATEGORIES: readonly string[] = ['correctness', 'security', 'maintainability'];

/** Bytes of hunk text one candidate may contribute. A hunk longer than this is
 *  cut with a marker rather than dropped: its head is where the change starts,
 *  and a candidate silently absent from the prompt would be a candidate the
 *  model was never able to choose. */
const MAX_HUNK_BYTES = 4_000;

/** Bytes of diff text across the whole prompt. Twelve full hunks of a 604-line
 *  median commit fit inside this; a pathological change is cut from the end,
 *  which is the low-weight end of the ranking. */
const MAX_TOTAL_BYTES = 40_000;

export interface SpotlightPromptOptions {
  candidates: readonly Candidate[];
  /** How many fragments to ask for. The report's range is three to five. */
  n: number;
  intent: string | null;
  band: string;
  score: number;
}

export function spotlightPrompt(options: SpotlightPromptOptions): string {
  const lines: string[] = [
    'You are selecting the few fragments of a code change that a human reviewer must read.',
    'You are not reviewing the change. Do not propose fixes, do not list defects, do not rewrite anything.',
    '',
    `A risk model has already scored this change ${options.score} and put it in band "${options.band}".`,
    'It has narrowed the change to the candidate fragments below, ordered by a weight computed from',
    'repository history. Your job is to pick the ones worth a human minute and say why in one sentence each.',
    '',
    'RULES',
    `1. Pick between 3 and ${Math.max(3, options.n)} fragments. Fewer than three only if the change genuinely has fewer candidates.`,
    '2. NEVER comment on style, formatting, naming, indentation, import order, comment wording or lint-shaped issues.',
    '   Measured against 18,000 human review comments, models over-report style by 328% and under-report',
    '   correctness by 42.6% and security by 89.5%. If a fragment is only interesting stylistically, drop it.',
    '3. Judge only what the fragment shows. Do not speculate about code you cannot see.',
    `4. Each fragment gets exactly one category: ${CATEGORIES.join(', ')}.`,
    '5. Each "why" is ONE sentence, under 200 characters, naming what a reader should check - not what is wrong.',
    '6. Keep the file and line exactly as given. Do not invent a fragment that is not in the list.',
    '',
    'ANSWER WITH JSON AND NOTHING ELSE, in exactly this shape:',
    '{"spotlight":[{"file":"path","line":12,"category":"correctness","why":"one sentence"}]}',
    '',
  ];
  if (options.intent !== null && options.intent.trim().length > 0) {
    lines.push('The author states the change was made for this reason:', options.intent.trim(), '');
  }
  lines.push('CANDIDATE FRAGMENTS', '');
  lines.push(renderCandidates(options.candidates));
  return lines.join('\n');
}

function renderCandidates(candidates: readonly Candidate[]): string {
  const parts: string[] = [];
  let budget = MAX_TOTAL_BYTES;
  for (const [index, candidate] of candidates.entries()) {
    const reasons = [
      `weight ${candidate.weight}`,
      `file risk ${candidate.file_risk}/100`,
      `${candidate.size} changed lines`,
    ];
    if (candidate.hard_rule) reasons.push('a hard rule protects this path');
    if (candidate.previously_blamed) reasons.push('a past fix blamed the commit that wrote these lines');
    if (candidate.no_test) reasons.push('no test changed alongside this file');
    if (candidate.created) reasons.push('new file');
    if (candidate.deleted) reasons.push('deleted file');
    const header = `--- fragment ${index + 1}: ${candidate.file}:${candidate.line} (${reasons.join(', ')})`;
    const body = budget <= 0 ? '(omitted: prompt size limit)' : clip(candidate.text, Math.min(MAX_HUNK_BYTES, budget));
    budget -= Buffer.byteLength(body, 'utf8');
    parts.push(`${header}\n${body}`);
  }
  return parts.join('\n\n');
}

function clip(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buffer = Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes));
  // Decoded with the replacement of a half-written character dropped, so a
  // multi-byte name never becomes mojibake in the prompt.
  const cut = new TextDecoder('utf-8', { fatal: false }).decode(buffer).replace(/�+$/, '');
  return `${cut}\n... (fragment truncated at ${maxBytes} bytes)`;
}

/**
 * Pass one of the drift check: describe the diff, without being told why it
 * was made.
 *
 * The intent is deliberately absent from this text. That is the anti-anchoring
 * property, and it is the reason the check is two calls rather than one.
 */
export function driftDescribePrompt(diff: string): string {
  return [
    'Describe what the following code change actually does.',
    '',
    'You are NOT told why it was made, and you must not guess at a motive.',
    'Report only what the diff shows, in exactly three short points, each one sentence.',
    'Name concrete behaviour: what is now computed, called, stored, refused or removed.',
    'Do not evaluate quality, do not mention style, do not suggest improvements.',
    '',
    'ANSWER WITH JSON AND NOTHING ELSE:',
    '{"describes":["first point","second point","third point"]}',
    '',
    'THE CHANGE',
    '',
    clip(diff, MAX_TOTAL_BYTES),
  ].join('\n');
}

/**
 * Pass two: compare that description with the stated intent.
 *
 * The diff itself is deliberately absent here. The comparison is between two
 * pieces of prose, which is what stops the second call from re-reading the code
 * and quietly agreeing with whichever of the two it saw last.
 */
export function driftComparePrompt(description: readonly string[], intent: string): string {
  return [
    'Compare a stated intent with an independent description of what a code change actually does.',
    '',
    'You cannot see the change itself, only these two texts. That is deliberate: judge the agreement',
    'between them, nothing else.',
    '',
    'STATED INTENT',
    intent.trim(),
    '',
    'WHAT THE CHANGE ACTUALLY DOES (written by someone who was not told the intent)',
    ...description.map((point, index) => `${index + 1}. ${point}`),
    '',
    'Grade the drift from 1 to 5:',
    '  1 - the change does what the intent says, and nothing else',
    '  2 - the change does what the intent says, plus something small the intent did not mention',
    '  3 - part of the intent is not visible in the change, or a substantial part of the change is unrequested',
    '  4 - the change is largely about something the intent does not describe',
    '  5 - the change and the intent are about different things',
    '',
    'Then list, in the two arrays:',
    '  missing_from_diff    - criteria the intent asks for that the description does not show',
    '  unrequested_in_diff  - things the description shows that the intent never asked for',
    'Each entry is one short sentence. Both arrays may be empty. Do not mention style or formatting.',
    '',
    'ANSWER WITH JSON AND NOTHING ELSE:',
    '{"drift":1,"missing_from_diff":[],"unrequested_in_diff":[]}',
  ].join('\n');
}
