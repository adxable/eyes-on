import type { Context } from './context.js';
import { assertMayMutate } from './context.js';
import { flagBool, flagString } from './args.js';
import { emitDoc, progress, EXIT_OK, EXIT_ERROR } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { assess, type Assessment } from '../risk/assess.js';
import { bandLabel } from '../risk/signals.js';
import { hitSentence } from '../rules/hard.js';
import { recordCheck, writeReport } from '../db/checks.js';
import { loadConfig } from '../core/config.js';

/**
 * `eyes-on check` - the product's answer to "does a human have to read this?"
 *
 * Two properties of this command are the product, not implementation details:
 *
 *   - **it never blocks.** The exit code is 0 whatever the score is and
 *     whatever the hard rules say. The research report's own conclusion from
 *     the reference repository's CI (section 372) is that one false red teaches
 *     a team to ignore every red after it, and a risk score is a heuristic by
 *     construction. `--strict` exists for a caller who has explicitly asked for
 *     a non-zero exit; nothing else produces one.
 *   - **it says where the number came from.** The rationale, the file that
 *     decided each signal, and the provenance of the config are all in the
 *     payload. A score nobody can argue with is a score nobody will trust.
 */
export async function checkCommand(context: Context): Promise<number> {
  assertMayMutate(context, 'check');

  const risk = riskContext(context);
  const intent = flagString(context.args, 'intent');
  const strict = flagBool(context.args, 'strict');

  if (risk.baseSHA === risk.headSHA) {
    progress(context.writers, `no change to assess: ${risk.baseFrom}`);
  }

  const assessment = assess({
    reader: risk.reader,
    db: risk.db,
    trusted: risk.trusted,
    baseSHA: risk.baseSHA,
    headSHA: risk.headSHA,
    nowSeconds: Math.floor(Date.now() / 1000),
    onProgress: (message) => progress(context.writers, message),
  });

  const doc = renderDoc(assessment, {
    branch: risk.branch,
    baseFrom: risk.baseFrom,
    intent,
    // Stage 2 delivers the drift signal and the fragment ranking. Saying so
    // beats an empty `spotlight` key that reads as "nothing worth reading".
    noModel: flagBool(context.args, 'no-model'),
    strict,
  });

  if (risk.db) {
    const id = recordCheck(risk.db, {
      repoId: risk.repoId,
      branch: risk.branch,
      intent,
      assessment,
    });
    doc.check_id = id;
    writeReport(context.paths, assessment.head_sha, { check_id: id, ...doc, files: assessment.files }, loadConfig(context.paths).reports.retention);
  }

  emitDoc(context.writers, context.format, doc, () => renderMarkdown(assessment, doc));

  // Exit 0 is the contract. `--strict` is the only door out of it, and it opens
  // only for the top band - the one that says a human must read this.
  return exitCodeFor(assessment, strict);
}

interface RenderOptions {
  branch: string;
  baseFrom: string;
  intent: string | null;
  noModel: boolean;
  /** Whether `--strict` was passed, because the payload reports the exit code
   *  the process is actually going to use and `--strict` is what changes it. */
  strict: boolean;
}

/** The one place the exit code is decided. Both the returned code and the
 *  `exit_code` field in the payload read it, so an agent parsing the document
 *  can never be told something different from what the shell sees. */
function exitCodeFor(assessment: Assessment, strict: boolean): number {
  return strict && assessment.band === 'pelna' ? EXIT_ERROR : EXIT_OK;
}

export function renderDoc(assessment: Assessment, options: RenderOptions): ToonObject {
  const topFiles = assessment.files.filter((file) => file.code).slice(0, 10);
  return {
    score: assessment.score,
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
      matched_files: hit.matched_files.join(' '),
      matched: hit.matched_files.length,
    })) as ToonValue,
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
    help: helpLines(assessment, options),
  };
}

function helpLines(assessment: Assessment, options: RenderOptions): ToonValue {
  const lines: string[] = [];
  if (assessment.config_state === 'unverified') {
    lines.push('config_state is unverified: hard rules were not evaluated, so this band is a lower bound');
  }
  if (assessment.hard_rules.length > 0) {
    lines.push('A hard rule matched, so the band is `pelna` whatever the score said');
  }
  lines.push('Run `eyes-on why <file>` to see where one file\'s risk came from');
  if (!options.noModel) {
    lines.push('Fragment ranking (`spotlight`) and intent drift arrive in stage 2; signal `drift` is weighted 0 here');
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
    `# eyes-on - ${assessment.score}/100, band: ${bandLabel(assessment.band)}`,
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
      ? 'eyes-on never blocks: this command exits 0 whatever the band is. Run `eyes-on why <file>` for one file\'s history.'
      : 'This run exits 1 because `--strict` was passed and the band is `pelna`; without `--strict` the same result exits 0. Run `eyes-on why <file>` for one file\'s history.',
  );
  return lines.join('\n');
}
