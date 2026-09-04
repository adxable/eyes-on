import type { Context } from './context.js';
import { flagCount, flagString } from './args.js';
import { emitDoc, EXIT_OK, progress, UserFacingError } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { normalizePath } from '../core/glob.js';
import { fileFilter, isTestFile } from '../risk/files.js';
import { readHistory } from '../risk/history.js';
import { attributeFixes, fixCountsByFile } from '../risk/szz.js';
import { freshness, rankFiles } from '../risk/assess.js';
import { saturate } from '../risk/signals.js';
import { rulesForFile } from '../rules/hard.js';
import { resolveDefaultBranch } from '../rules/trusted.js';

/**
 * `eyes-on why <file>` - where this file's risk came from.
 *
 * The command exists because a score nobody can interrogate is a score nobody
 * will act on. It answers with evidence rather than with numbers: the fix
 * commits that blamed into the file, by subject and date; the commits that
 * touched it in the window; whether a hard rule names it; and where it stands
 * in the repository's own ranking.
 *
 * Read-only, and it works on any file - not only one in the current change.
 * The most useful question is often about a file nobody is changing yet.
 */
export async function whyCommand(context: Context): Promise<number> {
  const target = context.args.positional[1];
  // A contract rather than a preference: a caller asking for the top billion
  // files is told so, instead of silently getting one.
  const asked = flagCount(context.args, 'top', {
    what: 'a positive count',
    help: ['For example: eyes-on why --top 10'],
    min: 1,
  });
  if (!target && asked === null) {
    throw new UserFacingError('eyes-on why needs a file', [
      'Usage: eyes-on why <file>',
      'Without a file, `eyes-on why --top <n>` lists where risk lives in this repository',
    ]);
  }
  const top = asked ?? 0;

  // `why` describes the repository as the default branch left it, so the range
  // that `check` needs is irrelevant here.
  const risk = riskContext(context, { dbMode: 'optional', needRange: false });
  const config = risk.trusted.config;
  const filter = fileFilter(config);
  const path = normalizePath(target ?? '');

  const anchor = resolveDefaultBranch(risk.clonePath, risk.reader, flagString(context.args, 'default-branch'));
  const headSHA = anchor?.sha ?? risk.reader.resolve('HEAD');
  if (!headSHA) {
    throw new UserFacingError(`cannot resolve a commit to read history from in ${risk.clonePath}`, [
      'Run this from a clone with at least one commit',
    ]);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const window = readHistory({
    reader: risk.reader,
    headSHA,
    windowDays: config.history_window_days,
    nowSeconds,
  });
  progress(context.writers, `${window.commits.length} commits in the last ${config.history_window_days} days`);

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

  if (!target) {
    emitRanking(context, ranked.slice(0, top), {
      total: ranked.length,
      windowDays: config.history_window_days,
      windowFrom: anchor ? `${anchor.ref} @ ${anchor.sha.slice(0, 12)}` : headSHA.slice(0, 12),
      includePatterns: filter.include.length,
    });
    return EXIT_OK;
  }

  const position = ranked.findIndex((entry) => entry.path === path);
  const history = window.files.get(path);
  const daysSince = history && history.lastTouched > 0 ? Math.max(0, Math.round((nowSeconds - history.lastTouched) / 86_400)) : null;

  const fixes = szz.attributions
    .filter((attribution) => attribution.files[path] !== undefined)
    .sort((a, b) => b.timestamp - a.timestamp);

  const isCode = filter.isCode(path);
  const doc: ToonObject = {
    file: path,
    known_to_history: history !== undefined,
    code: isCode,
    test: isTestFile(path),
    risk: ranked[position]?.risk ?? 0,
    rank: position < 0 ? null : position + 1,
    ranked_out_of: ranked.length,
    fix_commits: fixes.length,
    fix_history_normalized: round(saturate(fixes.length, config.saturation.fix_history)),
    churn: history?.commits ?? 0,
    churn_normalized: round(saturate(history?.commits ?? 0, config.saturation.churn)),
    days_since_touched: daysSince,
    recency_normalized: round(saturate(freshness(daysSince, config.saturation.recency), config.saturation.recency)),
    lines_added: history?.added ?? 0,
    lines_deleted: history?.deleted ?? 0,
    window_days: config.history_window_days,
    window_from: anchor ? `${anchor.ref} @ ${anchor.sha.slice(0, 12)}` : headSHA.slice(0, 12),
    fixes: fixes.map((fix) => ({
      sha: fix.sha.slice(0, 12),
      when: isoDay(fix.timestamp),
      blamed_lines: fix.files[path] ?? 0,
      subject: fix.subject,
    })) as ToonValue,
    recent_commits: (history?.recentSubjects ?? []).map((entry) => ({
      sha: entry.sha.slice(0, 12),
      when: isoDay(entry.timestamp),
      subject: entry.subject,
    })) as ToonValue,
    hard_rules: rulesForFile(config.hard_rules, path).map((rule) => ({ glob: rule.glob, why: rule.why })) as ToonValue,
    config_state: risk.trusted.state,
    help: helpLines(isCode, history !== undefined, filter.include.length) as ToonValue,
  };

  emitDoc(context.writers, context.format, doc, () => renderMarkdown(doc, fixes.length));
  return EXIT_OK;
}

function helpLines(isCode: boolean, known: boolean, includePatterns: number): string[] {
  const lines: string[] = [];
  if (!isCode) {
    lines.push(
      `This file is not code by the trusted include/exclude patterns (${includePatterns} include patterns), so it never enters the fix-history or churn signals`,
    );
  }
  if (!known) {
    lines.push('No commit in the history window touched this file, so every history signal is zero for it');
  }
  lines.push('Signals here are the file\'s own: size, spread and no-test are properties of a change, not of a file');
  return lines;
}

function isoDay(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function renderMarkdown(doc: ToonObject, fixCount: number): string {
  const rank = doc.rank === null ? 'unranked' : `#${String(doc.rank)} of ${String(doc.ranked_out_of)}`;
  const lines: string[] = [
    `# why \`${String(doc.file)}\` - risk ${String(doc.risk)}/100 (${rank})`,
    '',
    `Measured over ${String(doc.window_days)} days ending at ${String(doc.window_from)}.`,
    '',
    '| signal | raw | normalized |',
    '|---|---|---|',
    `| fix history | ${fixCount} fix commits blamed into it | ${String(doc.fix_history_normalized)} |`,
    `| churn | ${String(doc.churn)} commits | ${String(doc.churn_normalized)} |`,
    `| recency | ${doc.days_since_touched === null ? 'never touched in the window' : `${String(doc.days_since_touched)} days ago`} | ${String(doc.recency_normalized)} |`,
  ];

  const fixes = doc.fixes as { sha: string; when: string; blamed_lines: number; subject: string }[];
  if (fixes.length > 0) {
    lines.push('', '## Fixes that pointed at this file', '');
    for (const fix of fixes) {
      lines.push(`- \`${fix.sha}\` ${fix.when} - ${fix.subject} (${fix.blamed_lines} blamed lines)`);
    }
  } else {
    lines.push('', 'No fix commit in the window removed a line of this file.');
  }

  const rules = doc.hard_rules as { glob: string; why: string }[];
  if (rules.length > 0) {
    lines.push('', '## Hard rules naming this path', '');
    for (const rule of rules) {
      lines.push(`- \`${rule.glob}\`${rule.why ? ` - ${rule.why}` : ''}`);
    }
  }

  for (const line of doc.help as string[]) {
    lines.push('', `_${line}._`);
  }
  return lines.join('\n');
}

interface RankingMeta {
  total: number;
  windowDays: number;
  windowFrom: string;
  includePatterns: number;
}

/**
 * Where risk lives in this repository, regardless of any change.
 *
 * This is the ranking the noise-filter acceptance condition inspects, and the
 * reason it is printed at all: a filter nobody can look at is a filter nobody
 * can check. Only code files appear, by the trusted include and exclude
 * patterns - which is exactly the property being demonstrated.
 */
function emitRanking(
  context: Context,
  ranked: readonly { path: string; risk: number; fix_commits: number; churn: number; days_since_touched: number | null }[],
  meta: RankingMeta,
): void {
  const doc: ToonObject = {
    ranked: ranked.length,
    ranked_out_of: meta.total,
    window_days: meta.windowDays,
    window_from: meta.windowFrom,
    files: ranked.map((entry, index) => ({
      rank: index + 1,
      path: entry.path,
      risk: entry.risk,
      fix_commits: entry.fix_commits,
      churn: entry.churn,
      days_since_touched: entry.days_since_touched,
    })) as ToonValue,
    help: [
      `Only code files are ranked: ${meta.includePatterns} include patterns decide what counts, and documentation and log-shaped data files are deliberately absent`,
      'Run `eyes-on why <file>` for the fix commits behind one of these',
    ] as ToonValue,
  };
  emitDoc(context.writers, context.format, doc, () => {
    const lines = [
      `# where risk lives - top ${ranked.length} of ${meta.total} code files`,
      '',
      `Measured over ${meta.windowDays} days ending at ${meta.windowFrom}.`,
      '',
      '| # | file | risk | fixes | churn | last touched |',
      '|---|---|---|---|---|---|',
    ];
    ranked.forEach((entry, index) => {
      const touched = entry.days_since_touched === null ? 'outside window' : `${entry.days_since_touched}d ago`;
      lines.push(`| ${index + 1} | \`${entry.path}\` | ${entry.risk} | ${entry.fix_commits} | ${entry.churn} | ${touched} |`);
    });
    return lines.join('\n');
  });
}
