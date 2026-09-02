import { askModel, extractJson, resolveModelCommand, type ModelOptions, type ModelOutcome } from './agent.js';
import { driftComparePrompt, driftDescribePrompt } from './prompt.js';

/**
 * Intent against diff, in two passes.
 *
 * The research report (section 5.4) describes the mechanism Meta shipped and
 * the reason it is two calls: the first model sees the change and **not** the
 * intent, so its description cannot be shaped by what the change was supposed
 * to do; the second compares that description with the intent and never sees
 * the code. A single call given both reads the diff through the intent and
 * reports an agreement it has not checked. That is the entire design, and
 * collapsing it into one call would leave the command running and the answer
 * meaningless.
 *
 * The result is **shown, never a gate** (report section 5, P4). It does not
 * change an exit code, and the command that computes it exits 0 whatever the
 * grade is. It does raise the risk score through S7, at the report's weight of
 * 0.20 - a change that is not doing what it says is a change worth reading, and
 * the score is where "worth reading" is expressed.
 */

/** 1 means the change does what the intent says; 5 means they are about
 *  different things. The scale runs this way round because every signal in this
 *  product is "more is riskier", which is what one normalisation curve for all
 *  seven requires. */
export const MIN_GRADE = 1;
export const MAX_GRADE = 5;

export interface DriftResult {
  /** The grade, or null when the two passes did not both complete. */
  grade: number | null;
  /** The independent description of the diff, from the first pass. */
  describes: string[];
  missing_from_diff: string[];
  unrequested_in_diff: string[];
  /** The pass that decided the outcome: whichever failed, or the second one. */
  model: ModelOutcome;
  /** Which passes actually ran, for a payload that has to be honest about a
   *  half-finished measurement. */
  passes: { describe: ModelOutcome['state']; compare: ModelOutcome['state'] };
}

export interface DriftOptions {
  diff: string;
  intent: string;
  model: ModelOptions | null;
}

export function measureDrift(options: DriftOptions): DriftResult {
  const empty = { grade: null, describes: [], missing_from_diff: [], unrequested_in_diff: [] };

  if (options.model === null) {
    const outcome: ModelOutcome = {
      state: 'skipped',
      detail: '--no-model: drift is a model measurement and was not taken; signal S7 stays at zero',
    };
    return { ...empty, model: outcome, passes: { describe: 'skipped', compare: 'skipped' } };
  }
  if (options.diff.trim().length === 0) {
    const outcome: ModelOutcome = { state: 'skipped', detail: 'there is no diff between base and head to describe' };
    return { ...empty, model: outcome, passes: { describe: 'skipped', compare: 'skipped' } };
  }

  const resolved = resolveModelCommand(options.model);
  if ('refusal' in resolved) {
    return { ...empty, model: resolved.refusal, passes: { describe: resolved.refusal.state, compare: 'skipped' } };
  }

  const described = askModel(driftDescribePrompt(options.diff), options.model);
  if (described.state !== 'ok') {
    return { ...empty, model: described, passes: { describe: described.state, compare: 'skipped' } };
  }
  const describes = parseDescription(described.text);
  if (describes.length === 0) {
    const outcome: ModelOutcome = {
      state: 'failed',
      command: described.command,
      elapsed_ms: described.elapsed_ms,
      detail: 'the first pass did not describe the diff in a shape eyes-on could read, so no comparison was made',
    };
    return { ...empty, model: outcome, passes: { describe: 'failed', compare: 'skipped' } };
  }

  const compared = askModel(driftComparePrompt(describes, options.intent), options.model);
  if (compared.state !== 'ok') {
    return { ...empty, describes, model: compared, passes: { describe: 'ok', compare: compared.state } };
  }
  const verdict = parseComparison(compared.text);
  if (verdict === null) {
    const outcome: ModelOutcome = {
      state: 'failed',
      command: compared.command,
      elapsed_ms: compared.elapsed_ms,
      detail: 'the second pass did not return a grade between 1 and 5, so no drift is reported',
    };
    return { ...empty, describes, model: outcome, passes: { describe: 'ok', compare: 'failed' } };
  }

  return {
    grade: verdict.grade,
    describes,
    missing_from_diff: verdict.missing,
    unrequested_in_diff: verdict.unrequested,
    model: compared,
    passes: { describe: 'ok', compare: 'ok' },
  };
}

/**
 * The S7 raw value: how far above an aligned change this one is.
 *
 * A grade of 1 is the diff doing exactly what the intent said, and it
 * contributes nothing. Feeding the grade itself would put eight points on every
 * change that bothered to state an intent and have it confirmed - punishing the
 * measurement rather than the drift.
 */
export function driftSignalValue(grade: number | null): number {
  if (grade === null) return 0;
  return Math.max(0, Math.min(MAX_GRADE, grade) - MIN_GRADE);
}

/** One sentence for the pull-request comment and the Markdown rendering. */
export function driftSentence(result: DriftResult): string {
  if (result.grade === null) {
    return `not measured: ${detailOf(result.model)}`;
  }
  const first = result.unrequested_in_diff[0] ?? result.missing_from_diff[0];
  const tail = first ? ` - ${first}` : ' - the change and the stated intent agree';
  return `${result.grade}/5${tail}`;
}

export function detailOf(outcome: ModelOutcome): string {
  return 'detail' in outcome ? outcome.detail : 'the model answered';
}

export function parseDescription(text: string): string[] {
  const parsed = extractJson(text);
  if (parsed === null || typeof parsed !== 'object') return [];
  const list = (parsed as { describes?: unknown }).describes;
  if (!Array.isArray(list)) return [];
  return list
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().replace(/\s+/g, ' '))
    .filter((entry) => entry.length > 0)
    .slice(0, 5);
}

export function parseComparison(text: string): { grade: number; missing: string[]; unrequested: string[] } | null {
  const parsed = extractJson(text);
  if (parsed === null || typeof parsed !== 'object') return null;
  const map = parsed as Record<string, unknown>;
  const raw = typeof map.drift === 'number' ? map.drift : Number.parseInt(String(map.drift ?? ''), 10);
  if (!Number.isFinite(raw)) return null;
  const grade = Math.round(raw);
  if (grade < MIN_GRADE || grade > MAX_GRADE) return null;
  return {
    grade,
    missing: sentences(map.missing_from_diff),
    unrequested: sentences(map.unrequested_in_diff),
  };
}

function sentences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().replace(/\s+/g, ' '))
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.length > 240 ? `${entry.slice(0, 237)}...` : entry))
    .slice(0, 8);
}
