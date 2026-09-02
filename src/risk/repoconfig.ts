import { parseYaml, YamlError, type YamlMap, type YamlValue } from '../core/yaml.js';
import { glob, GlobError } from '../core/glob.js';

/**
 * `.eyes-on.yml` - the repository's own risk configuration (report Appendix
 * C.3).
 *
 * Every field here decides something about the outcome, which is why this file
 * is read from the **default branch at a pinned SHA** and never from the pushed
 * branch (report D4, and `trusted.ts` is where that is enforced). The parsing
 * lives here so both readers - the trusted one and the diagnostic "what does
 * this branch propose" one - agree on what a document means.
 *
 * Unreadable is not the same as absent, and the difference is the product:
 *
 *   - **absent** is the ordinary case. Defaults apply, there are no hard rules,
 *     and the assessment is complete.
 *   - **unreadable** means the trusted copy exists and cannot be understood, so
 *     eyes-on does not know which paths a human was supposed to be sent to. The
 *     check is marked `unverified` rather than quietly scored as if the file
 *     had been empty.
 */

export const REPO_CONFIG_FILE = '.eyes-on.yml';
export const REPO_CONFIG_SCHEMA = 'eyes-on/v1';

/** The seven signals, in the order the report lists them. */
export const SIGNAL_NAMES = [
  'fix_history',
  'churn',
  'size',
  'spread',
  'no_test',
  'recency',
  'drift',
] as const;

export type SignalName = (typeof SIGNAL_NAMES)[number];

export type SignalNumbers = Record<SignalName, number>;

export interface HardRule {
  glob: string;
  why: string;
}

export interface RepoConfig {
  schema: string;
  include: string[];
  exclude: string[];
  history_window_days: number;
  fix_commit_pattern: string;
  weights: SignalNumbers;
  saturation: SignalNumbers;
  thresholds: { read_fragments: number; full_review: number };
  hard_rules: HardRule[];
  /**
   * Which local agent the second stage of the fragment ranking and the drift
   * comparison call, and how many candidates the second stage is given.
   *
   * `agent` names one of `KNOWN_AGENTS`; eyes-on holds the argument vector that
   * name maps to, because this field is the one piece of repository content
   * that reaches process execution. `null` means the field was absent and the
   * built-in default applies; an explicitly empty string means this repository
   * has opted out of the model, which is the meaning Appendix C.3 gives an
   * empty value. The two must stay distinguishable: they produce the same
   * ranking and completely different explanations of why.
   *
   * `command` is the whole argv, and it is parsed but honoured only when the
   * machine's own `~/.eyes-on/config.yaml` sets `model.allow_any_command`. It
   * is kept rather than dropped so a repository that supplies one is told it
   * was refused instead of silently getting something else.
   */
  model: { agent: string | null; command: string[] | null; max_hunks: number };
}

/**
 * Weights and saturation constants are the report's, unchanged (section 5 and
 * Appendix C.3). They are not tuning knobs someone may adjust here: the whole
 * point of `backtest` and, later, `calibrate` is that a change to these numbers
 * is argued from measured history rather than from taste.
 *
 * `drift` moved from 0.00 to 0.20 at stage 2, on the report's own schedule, now
 * that P4 measures it. The other six are unchanged and the thresholds are
 * unchanged, so the weights sum to 1.20 rather than to 1: a change whose diff
 * does something its intent never mentioned can score above 100. That is the
 * report's arithmetic read literally, and it is why `maxScore` exists rather
 * than a hard-coded 100 - renormalising instead would quietly lower every
 * stage 1 score and move every change that sits near a threshold.
 *
 * S7 is only scored when drift was actually measured. A change assessed without
 * an intent, or with `--no-model`, carries S7 = 0 and scores exactly what it
 * would have scored at stage 1.
 */
export const DEFAULT_WEIGHTS: SignalNumbers = {
  fix_history: 0.3,
  churn: 0.2,
  size: 0.2,
  spread: 0.1,
  no_test: 0.15,
  recency: 0.05,
  drift: 0.2,
};

export const DEFAULT_SATURATION: SignalNumbers = {
  fix_history: 5,
  churn: 20,
  size: 400,
  spread: 12,
  no_test: 1,
  recency: 30,
  drift: 5,
};

export const DEFAULT_THRESHOLDS = { read_fragments: 35, full_review: 65 };

/**
 * The default idea of "a code file".
 *
 * This list is the noise filter, and it is a measured requirement rather than a
 * tidiness preference: without it the top of adx-worker's risk ranking is
 * `AGENTS.md`, a file no reviewer needs to be sent to (report section 8, stage
 * 1). The report's own sketch narrows `include` to a TypeScript repository;
 * the default has to work in a repository that has not configured anything, so
 * it names the languages instead of one project's.
 */
export const DEFAULT_INCLUDE: string[] = [
  '**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
  '**/*.{go,rs,py,rb,java,kt,kts,swift,scala,cs,php,dart,ex,exs,lua}',
  '**/*.{c,h,cc,cpp,cxx,hh,hpp,m,mm}',
  '**/*.{sql,sh,bash,zsh,ps1}',
  '**/*.{vue,svelte,astro}',
];

/**
 * Paths excluded even when they carry a code extension: vendored trees, build
 * output, generated files and lockfiles. A change to any of them is real, but
 * it is not review surface, and its churn would drown the files that are.
 */
export const DEFAULT_EXCLUDE: string[] = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/third_party/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/.next/**',
  '**/coverage/**',
  '**/*.generated.*',
  '**/*.gen.{ts,js,go}',
  '**/*.min.js',
  '**/*.pb.go',
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
];

/** Default fix-commit subject pattern (Appendix C.3). Reverts are recognised
 *  separately, by `git log` semantics rather than by convention. */
export const DEFAULT_FIX_PATTERN = '^(fix|hotfix)(\\(|:|!)';

export const DEFAULT_HISTORY_WINDOW_DAYS = 90;

export function defaultRepoConfig(): RepoConfig {
  return {
    schema: REPO_CONFIG_SCHEMA,
    include: [...DEFAULT_INCLUDE],
    exclude: [...DEFAULT_EXCLUDE],
    history_window_days: DEFAULT_HISTORY_WINDOW_DAYS,
    fix_commit_pattern: DEFAULT_FIX_PATTERN,
    weights: { ...DEFAULT_WEIGHTS },
    saturation: { ...DEFAULT_SATURATION },
    thresholds: { ...DEFAULT_THRESHOLDS },
    hard_rules: [],
    model: { agent: null, command: null, max_hunks: 12 },
  };
}

/** A document that exists and cannot be trusted to mean anything. The message
 *  reaches the user unchanged, so "unverified" is never a bare word. */
export class RepoConfigError extends Error {
  constructor(detail: string) {
    super(`${REPO_CONFIG_FILE} cannot be read: ${detail}`);
    this.name = 'RepoConfigError';
  }
}

function asMap(value: unknown): YamlMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as YamlMap) : {};
}

function asStringList(value: YamlValue | undefined, fallback: string[], field: string): string[] {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) throw new RepoConfigError(`${field} must be a list of patterns`);
  const list = value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new RepoConfigError(`${field} contains an entry that is not a pattern`);
    }
    return entry.trim();
  });
  for (const pattern of list) assertUsableGlob(pattern, field);
  return list;
}

function assertUsableGlob(pattern: string, field: string): void {
  try {
    glob(pattern);
  } catch (error) {
    throw new RepoConfigError(
      error instanceof GlobError ? `${field}: ${error.message}` : `${field}: ${(error as Error).message}`,
    );
  }
}

function asNumbers(value: YamlValue | undefined, fallback: SignalNumbers, field: string): SignalNumbers {
  if (value === undefined || value === null) return { ...fallback };
  const map = asMap(value);
  const out = { ...fallback };
  for (const [key, entry] of Object.entries(map)) {
    if (!(SIGNAL_NAMES as readonly string[]).includes(key)) {
      throw new RepoConfigError(`${field}.${key} is not one of the seven signals (${SIGNAL_NAMES.join(', ')})`);
    }
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
      throw new RepoConfigError(`${field}.${key} must be a number of zero or more`);
    }
    out[key as SignalName] = entry;
  }
  return out;
}

function asPositiveInt(value: YamlValue | undefined, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RepoConfigError(`${field} must be a positive number`);
  }
  return Math.floor(value);
}

function asHardRules(value: YamlValue | undefined): HardRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RepoConfigError('hard_rules must be a list');
  return value.map((entry, index) => {
    const map = asMap(entry);
    const pattern = map.glob;
    if (typeof pattern !== 'string' || pattern.trim().length === 0) {
      throw new RepoConfigError(`hard_rules[${index}] has no glob`);
    }
    assertUsableGlob(pattern.trim(), `hard_rules[${index}].glob`);
    const why = typeof map.why === 'string' ? map.why.trim() : '';
    return { glob: pattern.trim(), why };
  });
}

/**
 * Turns a parsed document into a config, or refuses it.
 *
 * Refusal is deliberate and is the opposite of how `config.yaml` (machine
 * policy, repaired on the spot) is treated: an unusable value here would change
 * which change reaches a human, so it stops the assessment rather than falling
 * back to a default that nobody chose.
 */
export function normalizeRepoConfig(parsed: unknown): RepoConfig {
  const base = defaultRepoConfig();
  const map = asMap(parsed);

  const schema = map.schema;
  if (schema !== undefined && schema !== null) {
    if (typeof schema !== 'string') throw new RepoConfigError('schema must be a string');
    if (schema.trim() !== REPO_CONFIG_SCHEMA) {
      throw new RepoConfigError(`schema ${schema} is not ${REPO_CONFIG_SCHEMA}`);
    }
  }

  const thresholdMap = asMap(map.thresholds);
  const read = asPositiveInt(thresholdMap.read_fragments, base.thresholds.read_fragments, 'thresholds.read_fragments');
  const full = asPositiveInt(thresholdMap.full_review, base.thresholds.full_review, 'thresholds.full_review');
  if (read >= full) {
    throw new RepoConfigError(
      `thresholds.read_fragments (${read}) must be below thresholds.full_review (${full}), or there is no middle band`,
    );
  }

  const fixPattern = map.fix_commit_pattern;
  const pattern = typeof fixPattern === 'string' && fixPattern.length > 0 ? fixPattern : base.fix_commit_pattern;
  try {
    new RegExp(pattern);
  } catch (error) {
    throw new RepoConfigError(`fix_commit_pattern is not a valid regular expression: ${(error as Error).message}`);
  }

  const modelMap = asMap(map.model);
  const command = Array.isArray(modelMap.command)
    ? modelMap.command.map((entry) => {
        if (typeof entry !== 'string') throw new RepoConfigError('model.command must be a list of strings');
        return entry;
      })
    : base.model.command;
  if (modelMap.agent !== undefined && modelMap.agent !== null && typeof modelMap.agent !== 'string') {
    throw new RepoConfigError('model.agent must be the name of one agent, as a string');
  }
  const agent = typeof modelMap.agent === 'string' ? modelMap.agent : base.model.agent;

  return {
    schema: REPO_CONFIG_SCHEMA,
    include: asStringList(map.include, base.include, 'include'),
    exclude: asStringList(map.exclude, base.exclude, 'exclude'),
    history_window_days: asPositiveInt(map.history_window_days, base.history_window_days, 'history_window_days'),
    fix_commit_pattern: pattern,
    weights: asNumbers(map.weights, base.weights, 'weights'),
    saturation: asNumbers(map.saturation, base.saturation, 'saturation'),
    thresholds: { read_fragments: read, full_review: full },
    hard_rules: asHardRules(map.hard_rules),
    model: { agent, command, max_hunks: asPositiveInt(modelMap.max_hunks, base.model.max_hunks, 'model.max_hunks') },
  };
}

/** Parses a `.eyes-on.yml` document. Every failure arrives as a
 *  `RepoConfigError` carrying what was wrong with it. */
export function parseRepoConfig(source: string): RepoConfig {
  let parsed: YamlValue;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    throw new RepoConfigError(error instanceof YamlError ? error.message : (error as Error).message);
  }
  return normalizeRepoConfig(parsed);
}
