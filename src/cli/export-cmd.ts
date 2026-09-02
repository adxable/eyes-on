import type { Context } from './context.js';
import { flagString } from './args.js';
import { emitDoc, EXIT_OK, progress, UserFacingError } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { directoryOf, fileFilter } from '../risk/files.js';
import { readHistory } from '../risk/history.js';
import { attributeFixes, fixCountsByFile } from '../risk/szz.js';
import { rankFiles } from '../risk/assess.js';
import { resolveDefaultBranch } from '../rules/trusted.js';
import {
  fitWithinCaps,
  MAX_BYTES,
  MAX_ENTRIES,
  renderPathInstructions,
  type PathInstruction,
} from '../rules/export.js';

/**
 * `eyes-on export-path-instructions` - what eyes-on knows, in a shape
 * no-mistakes can read.
 *
 * Two entry kinds, in this priority order, because the caps bite from the
 * bottom:
 *
 *   1. every hard rule, because a hard rule is a statement that statistics do
 *      not get a vote on this path;
 *   2. the directories history says attract fixes, with the evidence attached -
 *      the reviewing agent is told *why* the path is listed, not merely that it
 *      is, which is the difference between guidance and noise.
 *
 * Nothing is written anywhere. The block goes to stdout for a human to paste.
 */
/**
 * A candidate entry, carrying where it came from.
 *
 * The provenance travels with the entry rather than being recovered from its
 * position, because `fitWithinCaps` does not keep a prefix: a hard rule with a
 * long `why` can be dropped for bytes while a later history entry still fits.
 */
type Candidate = PathInstruction & { source: 'hard_rule' | 'history' };

export async function exportPathInstructionsCommand(context: Context): Promise<number> {
  const risk = riskContext(context, { dbMode: 'optional', needRange: false });
  const config = risk.trusted.config;
  const filter = fileFilter(config);

  const anchor = resolveDefaultBranch(risk.clonePath, risk.reader, flagString(context.args, 'default-branch'));
  const headSHA = anchor?.sha ?? risk.reader.resolve('HEAD');
  if (!headSHA) {
    throw new UserFacingError(`cannot resolve a commit to read history from in ${risk.clonePath}`, [
      'Run this from a clone with at least one commit',
    ]);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const window = readHistory({ reader: risk.reader, headSHA, windowDays: config.history_window_days, nowSeconds });
  const szz = attributeFixes(window.commits, {
    reader: risk.reader,
    db: risk.db,
    fixPattern: new RegExp(config.fix_commit_pattern),
    onProgress: (done, total) => {
      if (done === total || done % 25 === 0) progress(context.writers, `blaming fix commits: ${done}/${total}`);
    },
  });
  const fixCounts = fixCountsByFile(szz.attributions);
  const ranked = rankFiles(window, fixCounts, filter, config, nowSeconds);

  const minRiskRaw = flagString(context.args, 'min-risk');
  const minRisk = minRiskRaw === null ? null : Number.parseInt(minRiskRaw, 10);
  if (minRisk !== null && (!Number.isFinite(minRisk) || minRisk < 0 || minRisk > 100)) {
    throw new UserFacingError(`--min-risk ${minRiskRaw} is not a risk score between 0 and 100`, [
      'For example: eyes-on export-path-instructions --min-risk 50',
      `Leave --min-risk out to use this repository's own threshold, ${config.thresholds.read_fragments}`,
    ]);
  }
  const threshold = minRisk ?? config.thresholds.read_fragments;

  const candidates: Candidate[] = [
    ...config.hard_rules.map((rule): Candidate => ({
      source: 'hard_rule',
      path: rule.glob,
      instructions: [
        'eyes-on marks this path as requiring full human review, from a hard rule on the default branch.',
        rule.why.length > 0 ? `Reason recorded with the rule: ${rule.why}` : null,
        'Review the change here in full and say plainly what you could not verify.',
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    })),
    ...riskyDirectories(ranked, threshold, config.history_window_days),
  ];

  const fitted = fitWithinCaps(candidates);
  const block = renderPathInstructions(fitted.entries);
  const hardRulesKept = fitted.entries.filter((entry) => entry.source === 'hard_rule').length;

  const doc: ToonObject = {
    entries: fitted.entries.length,
    max_entries: MAX_ENTRIES,
    bytes: fitted.bytes,
    max_bytes: MAX_BYTES,
    within_caps: fitted.entries.length <= MAX_ENTRIES && fitted.bytes <= MAX_BYTES,
    dropped: fitted.dropped.length,
    // A real list, not a joined string: git does not quote a space, so a path
    // containing one cannot be read back out of a whitespace-joined field.
    dropped_paths: fitted.dropped.map((entry) => entry.path) as ToonValue,
    cap_reason: fitted.reason,
    // Counted off the emitted block, never inferred from position: the byte cap
    // skips one candidate and keeps the next, so the surviving entries are not
    // a prefix of the candidate list and no arithmetic on lengths is right.
    from_hard_rules: hardRulesKept,
    hard_rules_available: config.hard_rules.length,
    from_history: fitted.entries.length - hardRulesKept,
    risk_threshold: threshold,
    config_state: risk.trusted.state,
    config_branch: risk.trusted.branch,
    window_days: config.history_window_days,
    block,
    help: [
      'Paste the block into .no-mistakes.yaml on the default branch. eyes-on writes nothing: this is a bridge, not a dependency',
      `The caps are no-mistakes' own: at most ${MAX_ENTRIES} entries and ${MAX_BYTES} bytes of assembled review-prompt section`,
      fitted.dropped.length > 0
        ? `${fitted.dropped.length} lower-priority entries were dropped to stay inside the caps (${fitted.reason})`
        : 'Every candidate entry fitted inside the caps',
    ] as ToonValue,
  };

  emitDoc(context.writers, context.format, doc, () => renderMarkdown(doc, block));
  return EXIT_OK;
}

/**
 * Groups the riskiest files into directory rules.
 *
 * A per-file entry would burn the 32-entry budget on one package. A directory
 * carries the same instruction to every file a reviewer might open there, and
 * the evidence line names the worst file inside it so the rule is checkable.
 */
function riskyDirectories(
  ranked: readonly { path: string; risk: number; fix_commits: number; churn: number }[],
  threshold: number,
  windowDays: number,
): Candidate[] {
  const byDirectory = new Map<string, { risk: number; files: number; fixes: number; worst: string }>();
  for (const entry of ranked) {
    if (entry.risk < threshold) continue;
    const dir = directoryOf(entry.path);
    const existing = byDirectory.get(dir);
    if (!existing) {
      byDirectory.set(dir, { risk: entry.risk, files: 1, fixes: entry.fix_commits, worst: entry.path });
      continue;
    }
    existing.files += 1;
    existing.fixes += entry.fix_commits;
    if (entry.risk > existing.risk) {
      existing.risk = entry.risk;
      existing.worst = entry.path;
    }
  }

  return [...byDirectory.entries()]
    .sort((a, b) => b[1].risk - a[1].risk || b[1].files - a[1].files || a[0].localeCompare(b[0]))
    .map(([dir, stats]): Candidate => ({
      source: 'history',
      path: dir === '.' ? '*' : `${dir}/**`,
      instructions: [
        `eyes-on scores this directory ${stats.risk}/100 from repository history over the last ${windowDays} days.`,
        `${stats.files} code files here are above the risk threshold and they attracted ${stats.fixes} fix commits; the worst is ${stats.worst}.`,
        'Weight correctness over style here, and check the change against what the surrounding code already assumes.',
      ].join('\n'),
    }));
}

function renderMarkdown(doc: ToonObject, block: string): string {
  const lines: string[] = [
    '# eyes-on -> .no-mistakes.yaml',
    '',
    `${String(doc.entries)}/${String(doc.max_entries)} entries, ${String(doc.bytes)}/${String(doc.max_bytes)} bytes.`,
    Number(doc.hard_rules_available) > Number(doc.from_hard_rules)
      ? `${String(doc.from_hard_rules)} of ${String(doc.hard_rules_available)} hard rules on \`${String(doc.config_branch)}\` fitted, the rest from ${String(doc.window_days)} days of history.`
      : `${String(doc.from_hard_rules)} from hard rules on \`${String(doc.config_branch)}\`, the rest from ${String(doc.window_days)} days of history.`,
  ];
  if (Number(doc.dropped) > 0) {
    const dropped = (doc.dropped_paths as string[]).map((path) => `\`${path}\``).join(', ');
    lines.push('', `Dropped to stay inside the caps (${String(doc.cap_reason)}): ${dropped}.`);
  }
  lines.push('', '```yaml', block.trimEnd(), '```', '', `_${(doc.help as string[])[0] ?? ''}._`);
  return lines.join('\n');
}
