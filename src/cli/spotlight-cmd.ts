import type { Context } from './context.js';
import { assertMayMutate } from './context.js';
import { flagBool, flagString } from './args.js';
import { emitDoc, progress, EXIT_OK, EXIT_USAGE, UserFacingError } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { modelOptionsFor } from './model-context.js';
import { assess } from '../risk/assess.js';
import { bandLabel } from '../risk/signals.js';
import { findCheck, recordCheck } from '../db/checks.js';
import { latestDecision, recordSpots } from '../db/gate.js';
import { parseHunks } from '../spot/hunks.js';
import { blamedHunks, rankHunks, DEFAULT_MAX_PER_FILE, type Candidate } from '../spot/rank.js';
import { clampN, selectSpotlight, type Spot, type SpotlightResult } from '../spot/spotlight.js';
import { detailOf } from '../spot/drift.js';

/**
 * `eyes-on spotlight` - the three to five fragments a human should actually
 * read.
 *
 * The command is two stages and the split is mandatory (report section 5, P3).
 * Stage one is arithmetic over git and produces twelve candidates; stage two is
 * a single model call that picks a few of them and says why. The reason the
 * report makes it mandatory rather than an optimisation is a measurement: the
 * median commit in the reference repository is 604 lines, and a model handed
 * the whole change does not read the whole change.
 *
 * `--no-model` returns stage one alone and calls nothing. It is the path that
 * has to work when the model is rate-limited, so it is not a degraded mode with
 * an apology attached: it is a complete answer that says which stage produced
 * it.
 *
 * Drift is not measured here. When `check --intent` has already measured it for
 * this exact base and head, the grade is read back so that this command's score
 * is the same number `check` reported; measuring it again would be a second
 * pair of model calls to arrive at the same answer.
 */
export async function spotlightCommand(context: Context): Promise<number> {
  assertMayMutate(context, 'spotlight');

  const risk = riskContext(context);
  const requested = flagString(context.args, 'n');
  const n = clampN(requested === null ? 5 : Number.parseInt(requested, 10));
  if (requested !== null && !Number.isFinite(Number.parseInt(requested, 10))) {
    throw new UserFacingError(`--n ${requested} is not a number`, ['Pass --n 3, 4 or 5'], EXIT_USAGE);
  }
  const noModel = flagBool(context.args, 'no-model');

  if (risk.baseSHA === risk.headSHA) {
    progress(context.writers, `no change to rank: ${risk.baseFrom}`);
  }

  // The grade already measured for this exact change, so this command's score
  // agrees with the one `check --intent` printed instead of silently dropping
  // S7 back to zero.
  const existing = risk.db ? findCheck(risk.db, risk.repoId, risk.baseSHA, risk.headSHA) : undefined;

  const assessment = assess({
    reader: risk.reader,
    db: risk.db,
    trusted: risk.trusted,
    baseSHA: risk.baseSHA,
    headSHA: risk.headSHA,
    nowSeconds: Math.floor(Date.now() / 1000),
    driftGrade: existing?.drift ?? null,
    onProgress: (message) => progress(context.writers, message),
  });

  const ruleFiles = new Set(assessment.hard_rules.flatMap((hit) => hit.matched_files));
  const rankable = new Set([
    ...assessment.files.filter((file) => file.code).map((file) => file.path),
    ...ruleFiles,
  ]);
  const allHunks = parseHunks(risk.reader.rangePatch(risk.baseSHA, risk.headSHA));
  // The same noise filter the risk ranking uses, and for the same measured
  // reason: without it `AGENTS.md` is what a reviewer gets sent to. A hard rule
  // is the deliberate exception - it must reach a `deploy/values.yaml` that no
  // code filter would ever keep, which is the whole point of a hard rule. See
  // `docs/stage-2-acceptance.md` for the measurement.
  const hunks = allHunks.filter((entry) => rankable.has(entry.path));
  progress(
    context.writers,
    `${hunks.length} of ${allHunks.length} hunks are in code files or under a hard rule`,
  );

  const candidates = rankHunks({
    hunks,
    fileRisk: new Map(assessment.files.map((file) => [file.path, file.risk])),
    ruleFiles,
    untested: new Set(
      assessment.files.filter((file) => file.code && !file.test && !file.test_changed_with_it).map((file) => file.path),
    ),
    blamed: blamedHunks(risk.reader, risk.baseSHA, hunks, new Set(assessment.fix_introducers)),
    maxHunks: risk.trusted.config.model.max_hunks,
    maxPerFile: DEFAULT_MAX_PER_FILE,
  });
  progress(
    context.writers,
    `stage 1: ${candidates.length} candidates of ${hunks.length} hunks${noModel ? ' (--no-model: stopping here)' : ''}`,
  );

  const result = selectSpotlight({
    candidates,
    n,
    intent: flagString(context.args, 'intent') ?? existing?.intent ?? null,
    score: assessment.score,
    band: assessment.band,
    model: modelOptionsFor(context, risk.trusted.config, risk.clonePath),
  });
  if (result.stage === 1 && !noModel) {
    progress(context.writers, `stage 2 did not run: ${detailOf(result.model)}`);
  }

  let checkId: string | null = null;
  if (risk.db) {
    checkId = recordCheck(risk.db, {
      repoId: risk.repoId,
      branch: risk.branch,
      intent: existing?.intent ?? null,
      assessment,
      drift: existing?.drift ?? null,
    });
    recordSpots(risk.db, checkId, result.spots);
  }

  const doc = renderDoc(assessment.score, assessment.score_max, assessment.band, {
    result,
    candidates,
    hunks: hunks.length,
    hunksInChange: allHunks.length,
    n,
    checkId,
    gate: gateOf(risk, assessment.hard_rules.length, checkId),
    base: risk.baseSHA,
    head: risk.headSHA,
  });
  emitDoc(context.writers, context.format, doc, () => renderMarkdown(doc));
  // Directing attention is not blocking: a spotlight always exits 0.
  return EXIT_OK;
}

/** Parked when a rule fired and nobody has answered. Without a database there
 *  is nowhere an answer could have been recorded, so a hit is still a park. */
function gateOf(
  risk: ReturnType<typeof riskContext>,
  hits: number,
  checkId: string | null,
): 'must_read' | 'none' {
  if (hits === 0) return 'none';
  if (!risk.db || !checkId) return 'must_read';
  return latestDecision(risk.db, checkId) ? 'none' : 'must_read';
}

interface DocOptions {
  result: SpotlightResult;
  candidates: readonly Candidate[];
  hunks: number;
  /** Hunks before the code filter, so "nothing to rank" can say which of the
   *  two reasons it is. */
  hunksInChange: number;
  n: number;
  checkId: string | null;
  gate: 'must_read' | 'none';
  base: string;
  head: string;
}

export function renderDoc(score: number, scoreMax: number, band: string, options: DocOptions): ToonObject {
  const { result } = options;
  return {
    score,
    score_max: scoreMax,
    band,
    band_label: bandLabel(band as 'auto' | 'wskazane' | 'pelna'),
    base: options.base.slice(0, 12),
    head: options.head.slice(0, 12),
    check_id: options.checkId,
    gate: options.gate,
    stage: result.stage,
    asked_for: options.n,
    // Hunks after the code filter, and before it. The difference is what the
    // noise filter removed, which a reader should be able to see rather than
    // wonder about.
    hunks: options.hunks,
    hunks_in_change: options.hunksInChange,
    candidates_considered: options.candidates.length,
    model_state: result.model.state,
    model_detail: detailOf(result.model),
    model_command: 'command' in result.model ? (result.model.command.join(' ') as ToonValue) : null,
    model_elapsed_ms: 'elapsed_ms' in result.model ? result.model.elapsed_ms : null,
    rejected_fragments: result.rejected,
    rejected_reasons: result.rejected_reasons as ToonValue,
    // The answer. One row per fragment: file, line, category, sentence, weight
    // and which stage chose it.
    spotlight: result.spots.map((spot) => ({
      file: spot.file,
      line: spot.line,
      category: spot.category,
      why: spot.why,
      weight: spot.weight,
      source: spot.source,
    })) as ToonValue,
    // Stage one in full, so the model's selection can be argued with.
    candidates: options.candidates.map((candidate) => ({
      file: candidate.file,
      line: candidate.line,
      weight: candidate.weight,
      file_risk: candidate.file_risk,
      size: candidate.size,
      hard_rule: candidate.hard_rule,
      previously_blamed: candidate.previously_blamed,
      no_test: candidate.no_test,
    })) as ToonValue,
    exit_code: EXIT_OK,
    help: helpLines(options) as ToonValue,
  };
}

function helpLines(options: DocOptions): string[] {
  const lines: string[] = [];
  if (options.result.stage === 1) {
    lines.push(`Stage 1 only: ${detailOf(options.result.model)}`);
    lines.push('A stage 1 fragment has no category: the arithmetic knows a fragment is worth reading, not what kind of thing it is');
  }
  if (options.result.rejected > 0) {
    lines.push(
      `${options.result.rejected} fragment(s) the model returned were dropped because they did not name a candidate of this change`,
    );
  }
  if (options.candidates.length === 0) {
    lines.push(
      options.hunksInChange > 0
        ? 'Nothing to rank: no changed file is code by the trusted include patterns, and no hard rule named one'
        : 'Nothing to rank: the diff between base and head has no changed lines',
    );
  }
  if (options.gate === 'must_read') {
    lines.push(
      'A hard rule parked this change as `must_read`: answer with `eyes-on axi respond --action read` or `--action waive --reason "..."`',
    );
  }
  lines.push('Weight is file_risk x changed lines x 2 for a hard rule x 1.5 for previously blamed lines x 1.2 for no test');
  lines.push('Exit code is 0: a spotlight directs attention and blocks nothing');
  return lines;
}

export function renderMarkdown(doc: ToonObject): string {
  const spots = (doc.spotlight ?? []) as unknown as Spot[];
  const lines: string[] = [
    `# eyes-on spotlight - ${spots.length} fragment${spots.length === 1 ? '' : 's'} to read`,
    '',
    `Change ${String(doc.base)}..${String(doc.head)}, score ${String(doc.score)} of at most ${String(doc.score_max)}, band **${String(doc.band_label)}**.`,
    `Stage ${String(doc.stage)}: ${String(doc.candidates_considered)} candidates from ${String(doc.hunks)} hunks. ${String(doc.model_detail)}`,
  ];
  if (spots.length === 0) {
    lines.push('', 'Nothing to read: this change has no fragments the ranking could rank.');
    return lines.join('\n');
  }
  lines.push('', '## Read these places', '');
  for (const [index, spot] of spots.entries()) {
    const category = spot.category ? ` - ${spot.category}` : '';
    lines.push(`${index + 1}. \`${spot.file}:${spot.line}\`${category} - ${spot.why}`);
  }
  if (doc.gate === 'must_read') {
    lines.push('', '**Parked as `must_read`.** Answer with `eyes-on axi respond --action read`, or `--action waive --reason "..."`.');
  }
  lines.push(
    '',
    '---',
    '',
    'Weight is `file_risk x changed lines x 2 (hard rule) x 1.5 (previously blamed) x 1.2 (no test)`. Exit code is 0: a spotlight blocks nothing.',
  );
  return lines.join('\n');
}
