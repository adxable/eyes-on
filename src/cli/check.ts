import type { Context } from './context.js';
import { assertMayMutate } from './context.js';
import { flagBool, flagString } from './args.js';
import { emitDoc, progress, EXIT_OK, EXIT_ERROR } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { modelOptionsFor } from './model-context.js';
import { assess, type Assessment } from '../risk/assess.js';
import { bandLabel } from '../risk/signals.js';
import { hitSentence } from '../rules/hard.js';
import { recordCheck, writeReport } from '../db/checks.js';
import { latestDecision, recordDrift, type DecisionRow } from '../db/gate.js';
import { measureDrift, detailOf, type DriftResult } from '../spot/drift.js';
import { loadConfig } from '../core/config.js';

/**
 * `eyes-on check` - the product's answer to "does a human have to read this?"
 *
 * Three properties of this command are the product, not implementation details:
 *
 *   - **it never blocks.** The exit code is 0 whatever the score is, whatever
 *     the hard rules say and whatever the drift grade is. The research report's
 *     own conclusion from the reference repository's CI (section 372) is that
 *     one false red teaches a team to ignore every red after it, and a risk
 *     score is a heuristic by construction. `--strict` exists for a caller who
 *     has explicitly asked for a non-zero exit; nothing else produces one.
 *   - **it says where the number came from.** The rationale, the file that
 *     decided each signal, and the provenance of the config are all in the
 *     payload. A score nobody can argue with is a score nobody will trust.
 *   - **a hard rule parks the run.** The band was already `pelna`; the park is
 *     what turns that label into a decision somebody made. The check waits -
 *     in the record, not in the process - for `eyes-on axi respond`. Nothing
 *     outside eyes-on is held up by it, which is the point: the gate proves
 *     that a human was told, and has no lever to pull if they were not.
 *
 * Drift is measured here, and only here, when an intent is given: S7 is a
 * signal of the risk score, so it has to be known before the score is computed.
 * `--no-model` and a missing intent both leave it unmeasured, contributing zero
 * rather than an assumed agreement.
 */
export async function checkCommand(context: Context): Promise<number> {
  assertMayMutate(context, 'check');

  const risk = riskContext(context);
  const intent = flagString(context.args, 'intent');
  const strict = flagBool(context.args, 'strict');
  const noModel = flagBool(context.args, 'no-model');

  if (risk.baseSHA === risk.headSHA) {
    progress(context.writers, `no change to assess: ${risk.baseFrom}`);
  }

  const drift = driftFor(context, risk, intent);
  if (drift && drift.grade !== null) {
    progress(context.writers, `intent-versus-diff drift: ${drift.grade}/5`);
  }

  const assessment = assess({
    reader: risk.reader,
    db: risk.db,
    trusted: risk.trusted,
    baseSHA: risk.baseSHA,
    headSHA: risk.headSHA,
    nowSeconds: Math.floor(Date.now() / 1000),
    driftGrade: drift?.grade ?? null,
    onProgress: (message) => progress(context.writers, message),
  });

  let decision: DecisionRow | undefined;
  let checkId: string | null = null;
  if (risk.db) {
    checkId = recordCheck(risk.db, {
      repoId: risk.repoId,
      branch: risk.branch,
      intent,
      assessment,
      drift: drift?.grade ?? null,
    });
    if (drift) recordDrift(risk.db, checkId, drift);
    decision = latestDecision(risk.db, checkId);
  }

  const doc = renderDoc(assessment, {
    branch: risk.branch,
    baseFrom: risk.baseFrom,
    intent,
    noModel,
    strict,
    drift,
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
  if (intent === null || intent.trim().length === 0) return null;
  const model = modelOptionsFor(context, risk.trusted.config, risk.clonePath);
  if (model === null) {
    progress(context.writers, '--no-model: drift was not measured, so signal S7 stays at zero');
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
  drift: DriftResult | null;
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
    drift: options.drift?.grade ?? null,
    drift_state: driftState(options),
    drift_detail: options.drift ? detailOf(options.drift.model) : null,
    // Lists, not joined strings: a sentence containing the separator read back
    // out of a joined cell becomes two sentences nobody wrote.
    drift_missing_from_diff: (options.drift?.missing_from_diff ?? []) as ToonValue,
    drift_unrequested_in_diff: (options.drift?.unrequested_in_diff ?? []) as ToonValue,
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

/** Why there is or is not a drift grade, in one word an agent can branch on. */
function driftState(options: RenderOptions): string {
  if (options.drift === null) {
    if (options.noModel) return 'not measured: --no-model';
    return options.intent === null ? 'not measured: no --intent was given' : 'not measured';
  }
  return options.drift.grade === null ? 'not measured' : 'measured';
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
  if (options.drift === null && options.intent === null) {
    lines.push('Pass --intent "..." to measure intent-versus-diff drift; without it signal S7 is zero');
  }
  if (options.drift?.grade !== null && options.drift !== null) {
    lines.push('The drift grade is shown and scored as S7; it never changes the exit code');
  }
  lines.push(
    exitCodeFor(assessment, options.strict) === EXIT_OK
      ? 'Exit code is 0 by design: eyes-on directs attention, it does not block'
      : 'Exit code is 1 because --strict was passed and the band is `pelna`; without --strict this same result exits 0',
  );
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
    lines.push('', '## Intent versus diff', '', `Drift **${String(doc.drift)}/5**. Shown, never a gate.`);
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
    Number(doc.exit_code ?? EXIT_OK) === EXIT_OK
      ? 'eyes-on never blocks: this command exits 0 whatever the band is. Run `eyes-on spotlight` for the fragments to read, or `eyes-on why <file>` for one file\'s history.'
      : 'This run exits 1 because `--strict` was passed and the band is `pelna`; without `--strict` the same result exits 0. Run `eyes-on why <file>` for one file\'s history.',
  );
  return lines.join('\n');
}
