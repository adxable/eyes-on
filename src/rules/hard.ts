import { glob, normalizePath } from '../core/glob.js';
import type { HardRule, RepoConfig } from '../risk/repoconfig.js';

/**
 * Hard rules: paths where statistics do not get a vote.
 *
 * The research report's argument (section 1.1) is that deployment
 * configuration, data migrations and the code that talks to the outside world
 * fail rarely and catastrophically - a frequency-based signal is structurally
 * unable to protect them, because there is no frequency to learn from. So they
 * are matched by path and the result is not a score contribution but a band:
 * a hit means `pelna`, whatever the seven signals said.
 *
 * **Matching runs over the full changed-file list**, before any include or
 * exclude filter. This is deliberate and it is the same decision no-mistakes
 * makes for `path_instructions`: a rule that says "someone must read changes
 * under `deploy/`" must fire for `deploy/values.yaml`, which no code filter
 * would ever have kept. Filtering here would make the strongest guarantee in
 * the product quietly depend on a list of file extensions.
 */

export interface RuleHit {
  glob: string;
  why: string;
  /** Every changed file the rule matched, in the order git reported them. */
  matched_files: string[];
}

/** Evaluates the trusted rules against the full changed-file list. */
export function evaluateHardRules(rules: readonly HardRule[], changedFiles: readonly string[]): RuleHit[] {
  const paths = changedFiles.map(normalizePath);
  const hits: RuleHit[] = [];
  for (const rule of rules) {
    let compiled;
    try {
      compiled = glob(rule.glob);
    } catch {
      // A rule that cannot compile was already refused when the trusted config
      // was parsed, which is the only path that produces these. Reaching here
      // means a caller built rules by hand; skipping is safer than throwing
      // from inside a report.
      continue;
    }
    const matched = paths.filter((path) => compiled.matches(path));
    if (matched.length > 0) {
      hits.push({ glob: rule.glob, why: rule.why, matched_files: matched });
    }
  }
  return hits;
}

/** The rules whose glob names a path in the change, for `why <file>`. */
export function rulesForFile(rules: readonly HardRule[], path: string): HardRule[] {
  const clean = normalizePath(path);
  return rules.filter((rule) => {
    try {
      return glob(rule.glob).matches(clean);
    } catch {
      return false;
    }
  });
}

/**
 * The sentence a hit produces. Kept here rather than in each renderer so the
 * Markdown, the TOON and (in stage 2) the pull-request comment cannot drift
 * into saying three different things about the same hit.
 */
export function hitSentence(hit: RuleHit): string {
  const shown = hit.matched_files.slice(0, 3).join(', ');
  const rest = hit.matched_files.length > 3 ? ` and ${hit.matched_files.length - 3} more` : '';
  const why = hit.why.length > 0 ? ` - ${hit.why}` : '';
  return `${hit.glob} matched ${shown}${rest}${why}`;
}

/** True when any rule fired. A hit sets the band to `pelna` and nothing in the
 *  scoring can lower it again. */
export function anyHit(hits: readonly RuleHit[]): boolean {
  return hits.length > 0;
}

export function ruleCount(config: RepoConfig): number {
  return config.hard_rules.length;
}
