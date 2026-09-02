import type { Context } from './context.js';
import { assertMayMutate } from './context.js';
import { flagBool, flagString } from './args.js';
import { emitDoc, progress, EXIT_OK, EXIT_USAGE, UserFacingError } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { modelOptionsFor } from './model-context.js';
import { checkID } from '../db/checks.js';
import { recordDrift } from '../db/gate.js';
import { detailOf, driftSentence, measureDrift, type DriftResult } from '../spot/drift.js';

/**
 * `eyes-on drift` - does this change do what its author said it would?
 *
 * Two passes, against anchoring (research report section 5.4). The first model
 * call sees the diff and not the intent; the second sees that description and
 * the intent, and never the code. One call given both would read the diff
 * through the intent and report an agreement it never checked - which is a
 * command that runs, costs money and means nothing.
 *
 * The result is **shown and never a gate**. This command exits 0 for a drift of
 * 5 exactly as it does for a drift of 1, and `--strict` does not change that:
 * `--strict` is about the band, and drift does not set a band. The research
 * report's own finding is that showing an author the grade lowered drift by a
 * further 5.76 points on its own; the value is in the feedback, not in a veto.
 *
 * The grade is recorded against the change so `comment` can show it, but the
 * score it feeds - S7 at weight 0.20 - is computed by `check`, which is where
 * the score lives. This command says so rather than reporting a score that
 * would disagree with the recorded one.
 */
export async function driftCommand(context: Context): Promise<number> {
  assertMayMutate(context, 'drift');

  const risk = riskContext(context);
  const intent = flagString(context.args, 'intent') ?? intentFromRecord(risk);
  if (intent === null || intent.trim().length === 0) {
    throw new UserFacingError('drift needs an intent to compare the change against', [
      'Pass --intent "why this change was made - the reason, not the summary"',
      'Or run `eyes-on check --intent "..."` first: drift reuses the intent recorded for this change',
    ], EXIT_USAGE);
  }

  if (risk.baseSHA === risk.headSHA) {
    progress(context.writers, `no change to compare: ${risk.baseFrom}`);
  }

  const model = modelOptionsFor(context, risk.trusted.config, risk.clonePath);
  if (model !== null) {
    progress(context.writers, 'pass 1 of 2: describing the diff without showing the intent');
  }
  const result = measureDrift({
    diff: risk.reader.rangePatch(risk.baseSHA, risk.headSHA),
    intent,
    model,
  });
  if (result.describes.length > 0 && result.grade === null) {
    progress(context.writers, `pass 2 of 2 did not complete: ${detailOf(result.model)}`);
  }

  let checkId: string | null = null;
  if (risk.db) {
    checkId = checkID(risk.repoId, risk.baseSHA, risk.headSHA);
    // Only against a check that exists. A drift grade with no assessment behind
    // it would be a row nothing points at, and `comment` reads the assessment.
    const existing = risk.db.get<{ id: string }>('SELECT id FROM checks WHERE id = ?', checkId);
    if (existing) {
      risk.db.run('UPDATE checks SET intent = ?, intent_source = ? WHERE id = ?', intent, 'flag', checkId);
      recordDrift(risk.db, checkId, result);
    } else {
      checkId = null;
    }
  }

  const doc = renderDoc(result, {
    intent,
    base: risk.baseSHA,
    head: risk.headSHA,
    checkId,
    noModel: flagBool(context.args, 'no-model'),
  });
  emitDoc(context.writers, context.format, doc, () => renderMarkdown(result, doc));
  // Never a gate. Not even with --strict: drift does not set a band.
  return EXIT_OK;
}

/** The intent already recorded for this exact change, so a second command need
 *  not be given it again. */
function intentFromRecord(risk: ReturnType<typeof riskContext>): string | null {
  if (!risk.db) return null;
  const row = risk.db.get<{ intent: string | null }>(
    'SELECT intent FROM checks WHERE id = ?',
    checkID(risk.repoId, risk.baseSHA, risk.headSHA),
  );
  return row?.intent ?? null;
}

interface DocOptions {
  intent: string;
  base: string;
  head: string;
  checkId: string | null;
  noModel: boolean;
}

export function renderDoc(result: DriftResult, options: DocOptions): ToonObject {
  return {
    drift: result.grade,
    drift_scale: '1 = the change does what the intent says, 5 = they are about different things',
    state: result.grade === null ? 'not measured' : 'measured',
    detail: detailOf(result.model),
    base: options.base.slice(0, 12),
    head: options.head.slice(0, 12),
    check_id: options.checkId,
    intent: options.intent,
    pass_describe: result.passes.describe,
    pass_compare: result.passes.compare,
    // Three lists, each a real list. A joined string breaks on the first
    // sentence containing the separator, and every entry here is a sentence.
    describes: result.describes as ToonValue,
    missing_from_diff: result.missing_from_diff as ToonValue,
    unrequested_in_diff: result.unrequested_in_diff as ToonValue,
    signal: 'S7',
    signal_weight: 0.2,
    exit_code: EXIT_OK,
    help: helpLines(result, options) as ToonValue,
  };
}

function helpLines(result: DriftResult, options: DocOptions): string[] {
  const lines: string[] = [];
  if (result.grade === null) {
    lines.push(`No grade: ${detailOf(result.model)}`);
    if (options.noModel) {
      lines.push('Drift is a model measurement; --no-model has nothing to fall back to, unlike `spotlight`');
    }
  }
  if (options.checkId === null) {
    lines.push('Nothing was recorded: run `eyes-on check` on this change first, and the grade will be stored against it');
  }
  lines.push('Drift is shown, never a gate: this command exits 0 for a 5 exactly as it does for a 1');
  lines.push('The grade enters the risk score as signal S7 at weight 0.20 when you run `eyes-on check --intent "..."`');
  return lines;
}

export function renderMarkdown(result: DriftResult, doc: ToonObject): string {
  const lines: string[] = [
    `# eyes-on drift - ${driftSentence(result)}`,
    '',
    `Change ${String(doc.base)}..${String(doc.head)}. Two passes: the first described the diff without seeing the intent, the second compared that description with it.`,
    '',
    '## Stated intent',
    '',
    String(doc.intent ?? '').trim(),
  ];

  if (result.describes.length > 0) {
    lines.push('', '## What the change actually does, described without the intent', '');
    for (const point of result.describes) lines.push(`- ${point}`);
  }

  if (result.grade !== null) {
    lines.push('', `## Drift: ${result.grade}/5`, '');
    if (result.missing_from_diff.length === 0 && result.unrequested_in_diff.length === 0) {
      lines.push('Nothing asked for is missing, and nothing unrequested was found.');
    }
    for (const item of result.missing_from_diff) lines.push(`- **asked for, not in the change:** ${item}`);
    for (const item of result.unrequested_in_diff) lines.push(`- **in the change, not asked for:** ${item}`);
  } else {
    lines.push('', `**Not measured.** ${detailOf(result.model)}`);
  }

  lines.push(
    '',
    '---',
    '',
    'Drift is shown, never a gate: this command exits 0 whatever the grade is. It enters the score as S7 (weight 0.20) when `eyes-on check --intent "..."` runs.',
  );
  return lines.join('\n');
}
