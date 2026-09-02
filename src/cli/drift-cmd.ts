import type { Context } from './context.js';
import { assertMayMutate } from './context.js';
import { flagBool, flagString } from './args.js';
import { emitDoc, progress, EXIT_OK, EXIT_USAGE, UserFacingError } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { modelOptionsFor } from './model-context.js';
import { checkID, findCheck, recordCheck } from '../db/checks.js';
import { recordDrift } from '../db/gate.js';
import { assess, type Assessment } from '../risk/assess.js';
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
 * **This command never gates.** It exits 0 for a drift of 5 exactly as it does
 * for a drift of 1, with `--strict` or without it, because it computes no band
 * at all - there is nothing here for `--strict` to act on. The research
 * report's own finding is that showing an author the grade lowered drift by a
 * further 5.76 points on its own; the value is in the feedback, not in a veto.
 *
 * `eyes-on check` is a different sentence, and the honest one is: the grade
 * feeds S7 at weight 0.20, S7 is part of the score, and the band is a function
 * of the score. So under `check --strict` - which is the caller explicitly
 * asking for a non-zero exit on a `pelna` band - drift can carry a change over
 * the threshold exactly as any other signal can. Without `--strict` no drift
 * grade changes any exit code. Keeping S7 out of the band was rejected: it
 * would leave the score and the band disagreeing about the same change.
 *
 * **A fresh grade rescores the check it lands on.** The score, its maximum, the
 * band, the signal rows and the grade are five facts about one assessment, and
 * writing the grade alone would leave a 5/5 sitting beside a score that was
 * computed with S7 at zero - which is what every surface downstream would then
 * publish. So this command reassesses with the grade it just measured and
 * records the result through the same path `check` uses. The cost is a full
 * risk assessment rather than two model calls; that is the price of the four
 * numbers agreeing wherever they are read.
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
    files: risk.reader.changedFiles(risk.baseSHA, risk.headSHA),
    intent,
    model,
  });
  if (result.describes.length > 0 && result.grade === null) {
    progress(context.writers, `pass 2 of 2 did not complete: ${detailOf(result.model)}`);
  }

  let checkId: string | null = null;
  let assessment: Assessment | null = null;
  if (risk.db) {
    // Only against a check that exists. A drift grade with no assessment behind
    // it would be a row nothing points at, and `comment` reads the assessment.
    const existing = findCheck(risk.db, risk.repoId, risk.baseSHA, risk.headSHA);
    if (existing) {
      progress(context.writers, 'rescoring the recorded check with the grade just measured');
      assessment = assess({
        reader: risk.reader,
        db: risk.db,
        trusted: risk.trusted,
        baseSHA: risk.baseSHA,
        headSHA: risk.headSHA,
        nowSeconds: Math.floor(Date.now() / 1000),
        driftGrade: result.grade,
        onProgress: (message) => progress(context.writers, message),
      });
      checkId = recordCheck(risk.db, {
        repoId: risk.repoId,
        branch: risk.branch,
        intent,
        assessment,
        drift: result.grade,
      });
      recordDrift(risk.db, checkId, result);
    }
  }

  const doc = renderDoc(result, {
    intent,
    base: risk.baseSHA,
    head: risk.headSHA,
    checkId,
    assessment,
    noModel: flagBool(context.args, 'no-model'),
  });
  emitDoc(context.writers, context.format, doc, () => renderMarkdown(result, doc));
  // This command computes no band, so it has nothing for --strict to act on and
  // exits 0 at every grade. `check --strict` is the one that can exit non-zero,
  // and it does that from the band the score produces.
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
  /** The reassessment this run recorded, or null when there was no check to
   *  rescore. Reported here because this command moved those numbers. */
  assessment: Assessment | null;
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
    // The three numbers this command just moved, read from the assessment it
    // recorded rather than recomputed anywhere they are shown.
    score: options.assessment?.score ?? null,
    score_max: options.assessment?.score_max ?? null,
    band: options.assessment?.band ?? null,
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
  } else if (options.assessment) {
    lines.push(
      `The check was rescored with this grade: ${options.assessment.score} of at most ${options.assessment.score_max}, band \`${options.assessment.band}\` - so \`status\` and \`comment\` read the same numbers`,
    );
  }
  lines.push('This command exits 0 for a 5 exactly as it does for a 1, with --strict or without it: it computes no band');
  lines.push('The grade is signal S7 at weight 0.20 of the recorded score, and this command folded it in; there is no second command to run for that');
  lines.push('In the score it raises the band like any other signal, so `eyes-on check --strict` can exit 1 on it; `check` without --strict never does');
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
    `This command exits 0 whatever the grade is, with \`--strict\` or without it, because it computes no band.${
      doc.score === null
        ? ' Nothing was rescored: there is no recorded check for this change yet.'
        : ` The grade is signal S7 (weight 0.20) of the recorded score, and the check was rescored with it to ${String(doc.score)} of at most ${String(doc.score_max)}, band \`${String(doc.band)}\`.`
    } In the score it raises the band like any other signal, so \`eyes-on check --strict\` can exit 1 on it, and \`check\` without \`--strict\` never does.`,
  );
  return lines.join('\n');
}
