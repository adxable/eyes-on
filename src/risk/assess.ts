import type { Database } from '../db/db.js';
import type { ChangedFile, RepoReader } from '../git/reader.js';
import { evaluateHardRules, type RuleHit } from '../rules/hard.js';
import type { TrustedConfig } from '../rules/trusted.js';
import { directoryOf, fileFilter, isTestFile, testStem, type FileFilter } from './files.js';
import { codeFiles, readHistory, type FileHistory, type HistoryWindow } from './history.js';
import type { RepoConfig, SignalName } from './repoconfig.js';
import { rationale, saturate, scoreSignals, type Band, type RawSignals, type Score } from './signals.js';
import { attributeFixes, fixCountsByFile } from './szz.js';

/**
 * One assessment, end to end.
 *
 * The order below is the whole design, and two steps in it are load-bearing:
 *
 *   - **history stops at the base.** The window is walked from the merge base,
 *     not from the head. A change's own commits are the thing being assessed;
 *     counting them as history would let a branch raise its own churn signal by
 *     committing more often, and would credit the file it just created with the
 *     fix history of the fixes inside the branch.
 *   - **the config comes from the default branch.** `trusted.ts` owns that;
 *     everything here takes the config it is handed and never looks at the
 *     working tree.
 */

export interface AssessOptions {
  reader: RepoReader;
  db: Database | null;
  trusted: TrustedConfig;
  baseSHA: string;
  headSHA: string;
  /** "Now" for the history window. `check` passes the wall clock; `backtest`
   *  passes its split date, so the window is the one that existed then. */
  nowSeconds: number;
  onProgress?: (message: string) => void;
}

export interface FileAssessment {
  path: string;
  /** 0-100 over the three signals a file has on its own, renormalised by their
   *  weights. Not the change score: it answers "how risky is this file", which
   *  is what `why` and the noise-filter ranking ask. */
  risk: number;
  fix_commits: number;
  churn: number;
  /** Days since the file was last touched inside the window, or null when the
   *  window never saw it. */
  days_since_touched: number | null;
  added: number;
  deleted: number;
  /** True when this file is code by the trusted `include`/`exclude`. */
  code: boolean;
  test: boolean;
  /** True when the change also touched a test whose name matches this file. */
  test_changed_with_it: boolean;
}

export interface Assessment {
  base_sha: string;
  head_sha: string;
  score: number;
  band: Band;
  /** Band before the hard rules were applied, so a report can say that the rule
   *  is what moved it rather than implying the score did. */
  score_band: Band;
  signals: Score['signals'];
  rationale: string[];
  hard_rules: RuleHit[];
  /** `trusted`, `absent` or `unverified` - see `rules/trusted.ts`. */
  config_state: TrustedConfig['state'];
  config_detail: string | null;
  config_branch: string;
  config_sha: string | null;
  /** Every changed file, unfiltered: this is the list the hard rules matched. */
  changed_files: ChangedFile[];
  /** Per-file assessment for the changed code files, riskiest first. */
  files: FileAssessment[];
  /** How the history behind the score was gathered, for the cost condition and
   *  for an honest provenance line. */
  cost: {
    source: 'mirror' | 'clone';
    window_days: number;
    commits_walked: number;
    fix_commits: number;
    blames_cached: number;
    blames_computed: number;
    elapsed_ms: number;
  };
}

export function assess(options: AssessOptions): Assessment {
  const started = process.hrtime.bigint();
  const config = options.trusted.config;
  const filter = fileFilter(config);

  const changed = options.reader.changedFiles(options.baseSHA, options.headSHA);
  options.onProgress?.(`${changed.length} changed files`);

  // History stops at the base: see the header.
  const window = readHistory({
    reader: options.reader,
    headSHA: options.baseSHA,
    windowDays: config.history_window_days,
    nowSeconds: options.nowSeconds,
  });
  options.onProgress?.(`${window.commits.length} commits in the last ${config.history_window_days} days`);

  const szz = attributeFixes(window.commits, {
    reader: options.reader,
    db: options.db,
    fixPattern: new RegExp(config.fix_commit_pattern),
    onProgress: (done, total) => {
      if (done === 1 || done === total || done % 25 === 0) {
        options.onProgress?.(`blaming fix commits: ${done}/${total}`);
      }
    },
  });
  const fixCounts = fixCountsByFile(szz.attributions);

  const files = assessFiles(changed, { window, fixCounts, filter, config, nowSeconds: options.nowSeconds });
  const raw = rawSignals(changed, files, config);
  const scored = scoreSignals(raw, config);

  const hits = evaluateHardRules(config.hard_rules, changed.map((file) => file.path));
  const band: Band = hits.length > 0 ? 'pelna' : scored.band;

  return {
    base_sha: options.baseSHA,
    head_sha: options.headSHA,
    score: scored.score,
    band,
    score_band: scored.band,
    signals: scored.signals,
    rationale: rationale(scored),
    hard_rules: hits,
    config_state: options.trusted.state,
    config_detail: options.trusted.detail,
    config_branch: options.trusted.branch,
    config_sha: options.trusted.sha,
    changed_files: changed,
    files,
    cost: {
      source: options.reader.source,
      window_days: config.history_window_days,
      commits_walked: window.commits.length,
      fix_commits: szz.attributions.length,
      blames_cached: szz.cached,
      blames_computed: szz.computed,
      elapsed_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
    },
  };
}

interface FileContext {
  window: HistoryWindow;
  fixCounts: Map<string, number>;
  filter: FileFilter;
  config: RepoConfig;
  nowSeconds: number;
}

function assessFiles(changed: readonly ChangedFile[], context: FileContext): FileAssessment[] {
  const changedTestStems = new Set(
    changed.filter((file) => isTestFile(file.path)).map((file) => testStem(file.path)),
  );
  return changed
    .map((file) => {
      const history = context.window.files.get(file.path);
      const test = isTestFile(file.path);
      return {
        path: file.path,
        risk: fileRisk(file.path, context),
        fix_commits: context.fixCounts.get(file.path) ?? 0,
        churn: history?.commits ?? 0,
        days_since_touched: daysSince(history, context.nowSeconds),
        added: file.added,
        deleted: file.deleted,
        code: context.filter.isCode(file.path),
        test,
        test_changed_with_it: test ? true : changedTestStems.has(testStem(file.path)),
      };
    })
    .sort((a, b) => b.risk - a.risk || a.path.localeCompare(b.path));
}

function daysSince(history: FileHistory | undefined, nowSeconds: number): number | null {
  if (!history || history.lastTouched === 0) return null;
  return Math.max(0, Math.round((nowSeconds - history.lastTouched) / 86_400));
}

/**
 * Freshness, in days, of a file's last change.
 *
 * Inverted on purpose: the raw value is how much of the saturation window is
 * *left*, so a file touched today measures K and one untouched for the whole
 * window measures zero. The curve then reads the same way as every other
 * signal - more is riskier - which is what lets one normalisation serve all
 * seven. A file the window never saw scores zero, which is right: it is the
 * coldest thing in the change.
 */
export function freshness(daysSinceTouched: number | null, saturationDays: number): number {
  if (daysSinceTouched === null) return 0;
  return Math.max(0, saturationDays - daysSinceTouched);
}

/**
 * How risky a file is on its own, over the three signals that are properties of
 * a file rather than of a change: fix history, churn and recency.
 *
 * Renormalised by those three weights so the result is a 0-100 number
 * comparable with the change score, rather than a fraction of it that would
 * read as "every file is low risk".
 */
export function fileRisk(path: string, context: FileContext): number {
  const { config } = context;
  const history = context.window.files.get(path);
  const parts: SignalName[] = ['fix_history', 'churn', 'recency'];
  const weightSum = parts.reduce((sum, name) => sum + config.weights[name], 0);
  if (weightSum === 0) return 0;
  const values: Record<string, number> = {
    fix_history: context.fixCounts.get(path) ?? 0,
    churn: history?.commits ?? 0,
    recency: freshness(daysSince(history, context.nowSeconds), config.saturation.recency),
  };
  const total = parts.reduce(
    (sum, name) => sum + config.weights[name] * saturate(values[name] ?? 0, config.saturation[name]),
    0,
  );
  return Math.round((total / weightSum) * 100);
}

/**
 * The seven raw measurements.
 *
 * File-level signals aggregate by maximum over the changed **code** files, and
 * the file that produced the maximum is carried along so the rationale can name
 * it. Size and spread are counted over the same code files - see the note in
 * `signals.ts` about why one file set rather than two.
 */
export function rawSignals(
  changed: readonly ChangedFile[],
  files: readonly FileAssessment[],
  config: RepoConfig,
): RawSignals {
  const code = files.filter((file) => file.code);

  const maxBy = (pick: (file: FileAssessment) => number): { value: number; from: string | null } => {
    let best: { value: number; from: string | null } = { value: 0, from: null };
    for (const file of code) {
      const value = pick(file);
      if (value > best.value) best = { value, from: file.path };
    }
    return best;
  };

  const size = code.reduce((sum, file) => sum + file.added + file.deleted, 0);
  const directories = new Set(code.map((file) => directoryOf(file.path)));

  // Test files are excluded from the denominator: a change made entirely of
  // tests has not left anything untested, and dividing by it would score the
  // most disciplined change in the repository as the riskiest.
  const production = code.filter((file) => !file.test);
  const untested = production.filter((file) => !file.test_changed_with_it);
  const noTest = production.length === 0 ? 0 : untested.length / production.length;

  return {
    fix_history: maxBy((file) => file.fix_commits),
    churn: maxBy((file) => file.churn),
    size: { value: size, from: null },
    spread: { value: directories.size, from: null },
    no_test: { value: noTest, from: untested[0]?.path ?? null },
    recency: maxBy((file) => freshness(file.days_since_touched, config.saturation.recency)),
    // S7 lands in stage 2 (P4). It is measured as zero and weighted zero, and
    // the rationale says which signal is not yet scored rather than hiding it.
    drift: { value: 0, from: null },
  };
}

/** The riskiest files in a window, regardless of any change: the ranking the
 *  noise-filter acceptance condition inspects, and the input `backtest` and
 *  `export-path-instructions` both rank by. */
export function rankFiles(
  window: HistoryWindow,
  fixCounts: Map<string, number>,
  filter: FileFilter,
  config: RepoConfig,
  nowSeconds: number,
): { path: string; risk: number; fix_commits: number; churn: number; days_since_touched: number | null }[] {
  const context: FileContext = { window, fixCounts, filter, config, nowSeconds };
  return codeFiles(window, filter)
    .map((file) => ({
      path: file.path,
      risk: fileRisk(file.path, context),
      fix_commits: fixCounts.get(file.path) ?? 0,
      churn: file.commits,
      days_since_touched: daysSince(file, nowSeconds),
    }))
    .sort((a, b) => b.risk - a.risk || b.churn - a.churn || a.path.localeCompare(b.path));
}
