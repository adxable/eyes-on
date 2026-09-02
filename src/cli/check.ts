import type { Context } from './context.js';
import { assertMayMutate } from './context.js';
import { flagBool, flagString } from './args.js';
import { emitDoc, progress, EXIT_OK, EXIT_ERROR } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { modelOptionsFor } from './model-context.js';
import { assess, type Assessment } from '../risk/assess.js';
import {
  bandLabel,
  carryDrift,
  driftProvenanceSentence,
  statedIntent,
  type CarryDecision,
} from '../risk/signals.js';
import { hitSentence } from '../rules/hard.js';
import { findCheck, recordCheck, writeReport } from '../db/checks.js';
import {
  driftItemsFor,
  latestDecision,
  recordDrift,
  supersedeDrift,
  type DecisionRow,
  type DriftItemRow,
} from '../db/gate.js';
import { measureDrift, detailOf, type DriftResult } from '../spot/drift.js';
import { loadConfig } from '../core/config.js';

/**
 * `eyes-on check` - the product's answer to "does a human have to read this?"
 *
 * Three properties of this command are the product, not implementation details:
 *
 *   - **it blocks nothing the caller did not ask it to.** Without `--strict`
 *     the exit code is 0 whatever the score is, whatever the hard rules say and
 *     whatever the drift grade is. The research report's own conclusion from
 *     the reference repository's CI (section 372) is that one false red teaches
 *     a team to ignore every red after it, and a risk score is a heuristic by
 *     construction. `--strict` is the caller asking to gate on a `pelna` band;
 *     nothing else in the product produces a non-zero exit. `exitCodeSentence`
 *     is the one place that sentence is written, so no surface can say a
 *     stronger one than the code delivers.
 *   - **it says where the number came from.** The rationale, the file that
 *     decided each signal, and the provenance of the config are all in the
 *     payload. A score nobody can argue with is a score nobody will trust.
 *   - **a hard rule parks the run.** The band was already `pelna`; the park is
 *     what turns that label into a decision somebody made. The check waits -
 *     in the record, not in the process - for `eyes-on axi respond`. Nothing
 *     outside eyes-on is held up by it, which is the point: the gate proves
 *     that a human was told, and has no lever to pull if they were not.
 *
 * Drift is measured here when an intent is given: S7 is a signal of the risk
 * score, so it has to be known before the score is computed. `--no-model`, a
 * missing intent and a model that could not be reached all leave this run with
 * nothing measured, and then **not measuring is not changing**: a grade already
 * recorded against this base..head is a measurement of this diff, so it is
 * carried into the score rather than erased. Only a change nobody has ever
 * measured a grade for scores S7 at zero. Because that makes the score say more
 * than this invocation measured, `drift_provenance` names which of the three
 * states produced it and `driftProvenanceSentence` writes the one sentence
 * every surface prints.
 *
 * Being a signal is the whole of what S7 is, and that has one consequence worth
 * stating rather than discovering: the band is a function of the score, so a
 * drift grade can carry a change over `full_review` exactly as churn or size
 * can, and `--strict` will then exit 1 on it. Without `--strict` no drift grade
 * changes any exit code. Excluding S7 from the band was rejected - it would
 * leave `check` reporting a score and a band that disagree about one change.
 */
export async function checkCommand(context: Context): Promise<number> {
  assertMayMutate(context, 'check');

  const risk = riskContext(context);
  const intent = statedIntent(flagString(context.args, 'intent'));
  const strict = flagBool(context.args, 'strict');
  const noModel = flagBool(context.args, 'no-model');

  if (risk.baseSHA === risk.headSHA) {
    progress(context.writers, `no change to assess: ${risk.baseFrom}`);
  }

  // Read before anything is written: a grade already recorded against this
  // base..head is a measurement of this diff, and not measuring is not
  // changing. A run whose model was rate-limited carries it rather than
  // erasing it and publishing a score that dropped for no reason.
  const existing = risk.db ? findCheck(risk.db, risk.repoId, risk.baseSHA, risk.headSHA) : undefined;

  const drift = driftFor(context, risk, intent);
  if (drift && drift.grade !== null) {
    progress(context.writers, `intent-versus-diff drift: ${drift.grade}/5`);
  }
  const carry = carryDrift({
    measured: drift?.grade ?? null,
    intent,
    recordedGrade: existing?.drift ?? null,
    recordedIntent: existing?.drift_intent ?? null,
    recordedRowIntent: existing?.intent ?? null,
  });
  if (carry.provenance === 'carried') {
    progress(context.writers, `keeping the drift grade of ${String(carry.grade)}/5 already measured for this intent`);
  }
  if (carry.supersede) {
    progress(
      context.writers,
      `dropping the recorded drift grade of ${String(carry.superseded?.grade)}/5: it was measured against a different intent`,
    );
  }

  const assessment = assess({
    reader: risk.reader,
    db: risk.db,
    trusted: risk.trusted,
    baseSHA: risk.baseSHA,
    headSHA: risk.headSHA,
    nowSeconds: Math.floor(Date.now() / 1000),
    driftGrade: carry.grade,
    onProgress: (message) => progress(context.writers, message),
  });

  let decision: DecisionRow | undefined;
  let checkId: string | null = null;
  let driftItems: DriftItemRow[] | null = null;
  if (risk.db) {
    checkId = recordCheck(risk.db, {
      repoId: risk.repoId,
      branch: risk.branch,
      intent: carry.rowIntent,
      intentSource: intent === null && carry.rowIntent !== null ? 'carried' : undefined,
      assessment,
      drift: carry.grade,
      driftIntent: carry.intent,
    });
    // Only a run that measured one rewrites the items: `recordDrift` replaces
    // them, so calling it with an unmeasured result would delete the lists of
    // the measurement this run just kept.
    if (drift && drift.grade !== null) recordDrift(risk.db, checkId, drift, intent);
    else if (carry.supersede) supersedeDrift(risk.db, checkId, intent);
    decision = latestDecision(risk.db, checkId);
    // The two lists belong to the grade, so they are read back from the record
    // rather than from this run's result: a carried grade would otherwise be
    // published beside two empty lists, which reads as "the intent and the diff
    // agreed on everything" - the opposite of what the measurement found.
    driftItems = driftItemsFor(risk.db, checkId);
  }

  const doc = renderDoc(assessment, {
    branch: risk.branch,
    baseFrom: risk.baseFrom,
    intent,
    noModel,
    strict,
    drift,
    driftItems,
    carry,
    decision,
    checkId,
  });

  if (risk.db && checkId) {
    writeReport(
      context.paths,
      assessment.head_sha,
      { ...doc, files: assessment.files },
      loadConfig(context.paths).reports.retention,
    );
  }

  emitDoc(context.writers, context.format, doc, () => renderMarkdown(assessment, doc));

  // Exit 0 is the contract. `--strict` is the only door out of it, and it opens
  // only for the top band - the one that says a human must read this.
  return exitCodeFor(assessment, strict);
}

/**
 * Measures drift, or explains in one line on stderr why it was not measured.
 *
 * Returning null - rather than a result whose grade is null - is reserved for
 * "there was no intent to compare against", because that is the one case where
 * nothing was attempted and there is nothing to record.
 */
function driftFor(
  context: Context,
  risk: ReturnType<typeof riskContext>,
  intent: string | null,
): DriftResult | null {
  if (intent === null) return null;
  const model = modelOptionsFor(context, risk.trusted.config);
  if (model === null) {
    progress(context.writers, '--no-model: this run measured no drift');
    return null;
  }
  progress(context.writers, 'comparing the stated intent with the diff, in two passes');
  const result = measureDrift({
    diff: risk.reader.rangePatch(risk.baseSHA, risk.headSHA),
    files: risk.reader.changedFiles(risk.baseSHA, risk.headSHA),
    intent,
    model,
  });
  if (result.grade === null) {
    progress(context.writers, `drift was not measured: ${detailOf(result.model)}`);
  }
  return result;
}

interface RenderOptions {
  branch: string;
  baseFrom: string;
  intent: string | null;
  noModel: boolean;
  /** Whether `--strict` was passed, because the payload reports the exit code
   *  the process is actually going to use and `--strict` is what changes it. */
  strict: boolean;
  /** What this run measured, or null when it measured nothing. */
  drift: DriftResult | null;
  /** The two lists as they stand on the record, or null when there was no
   *  database to record them in. They belong to the grade rather than to this
   *  invocation, so a carried grade is published with the lists it was measured
   *  with. */
  driftItems: DriftItemRow[] | null;
  /** Which grade the score was computed with, where it came from, and the
   *  intent it answers. */
  carry: CarryDecision;
  decision: DecisionRow | undefined;
  checkId: string | null;
}

/** The one place the exit code is decided. Both the returned code and the
 *  `exit_code` field in the payload read it, so an agent parsing the document
 *  can never be told something different from what the shell sees. */
function exitCodeFor(assessment: Assessment, strict: boolean): number {
  return strict && assessment.band === 'pelna' ? EXIT_ERROR : EXIT_OK;
}

/**
 * The one sentence that describes that exit code, derived from the code itself.
 *
 * Every surface prints this rather than writing its own. Three rounds of review
 * found three different renderings of this claim disagreeing with each other
 * and with the code, because each was written where it was shown; a sentence
 * computed from the number it describes cannot drift away from it.
 */
export function exitCodeSentence(code: number): string {
  return code === EXIT_OK
    ? 'Without `--strict` this command exits 0 whatever the band is; `--strict` is the caller asking to gate on a `pelna` band, and this run exits 0'
    : 'This run exits 1 because `--strict` was passed and the band is `pelna`; without `--strict` this same result exits 0';
}

/**
 * Whether this run is parked.
 *
 * Computed from the same two facts the recorded status is computed from - a
 * rule fired, and no decision has been recorded - so the payload and the
 * database cannot disagree about whether somebody still has to answer.
 */
function gateOf(assessment: Assessment, decision: DecisionRow | undefined): 'must_read' | 'none' {
  if (assessment.hard_rules.length === 0) return 'none';
  return decision ? 'none' : 'must_read';
}

export function renderDoc(assessment: Assessment, options: RenderOptions): ToonObject {
  const topFiles = assessment.files.filter((file) => file.code).slice(0, 10);
  const gate = gateOf(assessment, options.decision);
  return {
    // Identity of the recorded assessment. `axi respond`, `comment` and stage
    // 3's ledger all address a check by it.
    check_id: options.checkId,
    score: assessment.score,
    score_max: assessment.score_max,
    band: assessment.band,
    band_label: bandLabel(assessment.band),
    band_from: assessment.hard_rules.length > 0 ? 'hard rule' : 'score',
    branch: options.branch,
    base: assessment.base_sha.slice(0, 12),
    head: assessment.head_sha.slice(0, 12),
    base_from: options.baseFrom,
    changed_files: assessment.changed_files.length,
    code_files: assessment.files.filter((file) => file.code).length,
    config_state: assessment.config_state,
    config_branch: assessment.config_branch,
    config_sha: assessment.config_sha ? assessment.config_sha.slice(0, 12) : null,
    config_detail: assessment.config_detail,
    intent: options.intent,
    // The gate. `must_read` means a hard rule fired and nobody has answered
    // yet; it changes no exit code and holds nothing outside eyes-on.
    gate,
    decision: options.decision?.action ?? null,
    decision_reason: options.decision?.reason ?? null,
    decided_by: options.decision?.decided_by ?? null,
    drift: options.carry.grade,
    // Whether this invocation measured that grade or carried it, and which
    // intent it answers. A score carrying a grade this run did not take says
    // more than this run measured unless the payload says which.
    drift_provenance: options.carry.provenance,
    drift_intent: options.carry.intent,
    drift_sentence: driftProvenanceSentence(options.carry),
    drift_state: driftState(options),
    drift_detail: options.drift ? detailOf(options.drift.model) : null,
    // Lists, not joined strings: a sentence containing the separator read back
    // out of a joined cell becomes two sentences nobody wrote.
    drift_missing_from_diff: driftItemsOf(options, 'missing_from_diff') as ToonValue,
    drift_unrequested_in_diff: driftItemsOf(options, 'unrequested_in_diff') as ToonValue,
    signals: assessment.signals.map((signal) => ({
      name: signal.name,
      raw: round(signal.raw),
      normalized: round(signal.normalized),
      weight: signal.weight,
      points: Math.round(signal.contribution * 100),
      from: signal.from,
    })) as ToonValue,
    rationale: assessment.rationale as ToonValue,
    hard_rules: assessment.hard_rules.map((hit) => ({
      glob: hit.glob,
      why: hit.why,
      matched: hit.matched_files.length,
    })) as ToonValue,
    // One row per matched file rather than a whitespace-joined cell. Git does
    // not quote a space, so `deploy/my values.yaml` read back out of a joined
    // field becomes two paths that do not exist - in the field that names what
    // fired the strongest guarantee in the product. This list encoding
    // supersedes the space-joined sketch in the scope report's Appendix C.4:
    // one path per cell needs no separator at all.
    hard_rule_matches: assessment.hard_rules.flatMap((hit) =>
      hit.matched_files.map((file) => ({ glob: hit.glob, file })),
    ) as ToonValue,
    top_files: topFiles.map((file) => ({
      path: file.path,
      risk: file.risk,
      fix_commits: file.fix_commits,
      churn: file.churn,
      days_since_touched: file.days_since_touched,
      lines: file.added + file.deleted,
      test_changed_with_it: file.test_changed_with_it,
    })) as ToonValue,
    source: assessment.cost.source,
    elapsed_ms: assessment.cost.elapsed_ms,
    commits_walked: assessment.cost.commits_walked,
    blames_cached: assessment.cost.blames_cached,
    blames_computed: assessment.cost.blames_computed,
    exit_code: exitCodeFor(assessment, options.strict),
    help: helpLines(assessment, options, gate),
  };
}

/**
 * One of the two recorded lists, taken from the record rather than from this
 * run, so a grade and the lists beside it always answer the same measurement.
 * The result of this run is the fallback for a run with no database to read.
 */
function driftItemsOf(options: RenderOptions, kind: 'missing_from_diff' | 'unrequested_in_diff'): string[] {
  if (options.driftItems !== null) {
    return options.driftItems.filter((row) => row.kind === kind).map((row) => row.item);
  }
  return [...(options.drift?.[kind] ?? [])];
}

/** Why there is or is not a drift grade, in one word an agent can branch on. */
function driftState(options: RenderOptions): string {
  if (options.carry.provenance === 'measured') return 'measured';
  if (options.carry.provenance === 'carried') return 'carried from an earlier measurement of this same intent';
  if (options.carry.supersede) return 'not measured: the recorded grade answers a different intent';
  if (options.drift === null) {
    // A run given no intent asked no drift question, so `--no-model` is not why
    // it has no grade: naming it would tell an agent that retrying with a model
    // would produce one, which it would not.
    if (options.intent === null) return 'not measured: no --intent was given';
    return options.noModel ? 'not measured: --no-model' : 'not measured';
  }
  return 'not measured';
}

function helpLines(assessment: Assessment, options: RenderOptions, gate: 'must_read' | 'none'): ToonValue {
  const lines: string[] = [];
  if (assessment.config_state === 'unverified') {
    lines.push('config_state is unverified: hard rules were not evaluated, so this band is a lower bound');
  }
  if (assessment.hard_rules.length > 0) {
    lines.push('A hard rule matched, so the band is `pelna` whatever the score said');
  }
  if (gate === 'must_read') {
    lines.push(
      'This run is parked as `must_read`: answer with `eyes-on axi respond --action read` or ' +
        '`eyes-on axi respond --action waive --reason "..."`. Nothing outside eyes-on is held up by it',
    );
  } else if (options.decision) {
    lines.push(
      `A hard rule matched and the gate was answered: ${options.decision.action}${options.decision.reason ? ` - ${options.decision.reason}` : ''}`,
    );
  }
  lines.push('Run `eyes-on why <file>` to see where one file\'s risk came from');
  lines.push('Run `eyes-on spotlight` for the three to five fragments a reviewer should actually read');
  if (options.intent === null) {
    lines.push(
      options.carry.provenance === 'carried'
        ? 'This run was given no --intent, so it asked no drift question and left the recorded grade and its lists alone'
        : 'Pass --intent "..." to measure intent-versus-diff drift; without a grade signal S7 is zero',
    );
  }
  if (options.carry.provenance !== 'none' || options.carry.supersede) {
    lines.push(driftProvenanceSentence(options.carry));
  }
  if (options.carry.provenance !== 'none') {
    lines.push(
      'The drift grade is scored as S7, so it moves the band like any other signal: without --strict it changes no exit code, and with --strict it can',
    );
  }
  if (options.carry.provenance === 'carried' || options.carry.supersede) {
    lines.push('Re-run with --intent "..." and a reachable model to measure the grade against the intent stated now');
  }
  lines.push(exitCodeSentence(exitCodeFor(assessment, options.strict)));
  return lines as ToonValue;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function renderMarkdown(assessment: Assessment, doc: ToonObject): string {
  const lines: string[] = [
    `# eyes-on - ${assessment.score} of at most ${assessment.score_max}, band: ${bandLabel(assessment.band)}`,
    '',
    `- branch \`${String(doc.branch)}\`, ${assessment.base_sha.slice(0, 12)}..${assessment.head_sha.slice(0, 12)} (${String(doc.base_from)})`,
    `- ${assessment.changed_files.length} changed files, ${String(doc.code_files)} of them code`,
    `- history: ${assessment.cost.commits_walked} commits over ${assessment.cost.window_days} days, read from the ${assessment.cost.source}`,
    `- configuration: ${assessment.config_state} (${assessment.config_branch}${assessment.config_sha ? ` @ ${assessment.config_sha.slice(0, 12)}` : ''})`,
  ];

  if (assessment.config_detail) {
    lines.push('', `**Unverified.** ${assessment.config_detail}`);
  }

  if (assessment.hard_rules.length > 0) {
    lines.push('', '## Hard rules', '');
    for (const hit of assessment.hard_rules) {
      lines.push(`- ${hitSentence(hit)}`);
    }
    lines.push('', `Band is \`pelna\` because of the rule above; the score alone would have said \`${assessment.score_band}\`.`);
    lines.push(
      '',
      String(doc.gate) === 'must_read'
        ? '**Parked as `must_read`.** Answer with `eyes-on axi respond --action read`, or `--action waive --reason "..."`. Nothing outside eyes-on is waiting on it.'
        : `**Gate answered:** ${String(doc.decision)}${doc.decision_reason ? ` - ${String(doc.decision_reason)}` : ''}${doc.decided_by ? ` (${String(doc.decided_by)})` : ''}.`,
    );
  }

  if (doc.drift !== null && doc.drift !== undefined) {
    lines.push(
      '',
      '## Intent versus diff',
      '',
      `${String(doc.drift_sentence)} It moves the band like every other signal: it changes no exit code except under the explicitly opted-in \`--strict\`.`,
    );
    for (const item of (doc.drift_missing_from_diff as string[]) ?? []) {
      lines.push(`- asked for and not visible in the change: ${item}`);
    }
    for (const item of (doc.drift_unrequested_in_diff as string[]) ?? []) {
      lines.push(`- in the change and not asked for: ${item}`);
    }
  } else if (doc.drift_state !== 'not measured: no --intent was given') {
    lines.push('', `_Drift: ${String(doc.drift_state)}${doc.drift_detail ? ` - ${String(doc.drift_detail)}` : ''}._`);
  }

  lines.push('', '## Why this score', '');
  for (const reason of assessment.rationale) {
    lines.push(`- ${reason}`);
  }

  const topFiles = assessment.files.filter((file) => file.code).slice(0, 10);
  if (topFiles.length > 0) {
    lines.push('', '## Changed code files, riskiest first', '', '| file | risk | fixes | churn | last touched | lines | test with it |', '|---|---|---|---|---|---|---|');
    for (const file of topFiles) {
      const touched = file.days_since_touched === null ? 'outside window' : `${file.days_since_touched}d ago`;
      lines.push(
        `| \`${file.path}\` | ${file.risk} | ${file.fix_commits} | ${file.churn} | ${touched} | ${file.added + file.deleted} | ${file.test_changed_with_it ? 'yes' : 'no'} |`,
      );
    }
  }

  lines.push(
    '',
    '---',
    '',
    `${exitCodeSentence(Number(doc.exit_code ?? EXIT_OK))}. Run \`eyes-on spotlight\` for the fragments to read, or \`eyes-on why <file>\` for one file's history.`,
  );
  return lines.join('\n');
}
