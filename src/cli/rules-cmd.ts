import type { Context } from './context.js';
import { flagBool } from './args.js';
import { emitDoc, EXIT_ERROR, EXIT_OK } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { evaluateHardRules, hitSentence } from '../rules/hard.js';
import { REPO_CONFIG_FILE } from '../risk/repoconfig.js';

/**
 * `eyes-on rules --check` - the hard rules on their own, with no scoring.
 *
 * It exists so the trust property can be inspected without running a whole
 * assessment, and the payload is built to make that inspection possible: it
 * names the branch and commit the rules were read from, so a reader can see
 * for themselves that the answer did not come from the branch under test.
 *
 * The acceptance condition this command carries is a single sentence: a branch
 * that deletes a rule from `.eyes-on.yml` still gets that rule. Nothing here
 * consults the working tree, and `trusted.ts` is where that is enforced.
 */
export async function rulesCommand(context: Context): Promise<number> {
  // `--check` is the only mode the report gives this command, and a bare
  // `eyes-on rules` meaning the same thing is friendlier than a usage error.
  const risk = riskContext(context, { dbMode: 'none' });
  const config = risk.trusted.config;
  const changed = risk.reader.changedFiles(risk.baseSHA, risk.headSHA);
  const paths = changed.map((file) => file.path);
  const hits = evaluateHardRules(config.hard_rules, paths);

  const doc: ToonObject = {
    band: hits.length > 0 ? 'pelna' : 'not set by a rule',
    rules_evaluated: config.hard_rules.length,
    rules_hit: hits.length,
    changed_files: paths.length,
    config_state: risk.trusted.state,
    config_file: REPO_CONFIG_FILE,
    config_branch: risk.trusted.branch,
    config_ref: risk.trusted.ref,
    config_sha: risk.trusted.sha ? risk.trusted.sha.slice(0, 12) : null,
    config_detail: risk.trusted.detail,
    base: risk.baseSHA.slice(0, 12),
    head: risk.headSHA.slice(0, 12),
    hard_rules: hits.map((hit) => ({
      glob: hit.glob,
      why: hit.why,
      matched: hit.matched_files.length,
      matched_files: hit.matched_files.join(' '),
    })) as ToonValue,
    exit_code: 0,
    help: [
      `Rules are read from ${risk.trusted.branch} at a pinned commit, never from the branch being assessed: a branch that deletes a rule still gets it`,
      'Matching runs over the full changed-file list, before any include or exclude filter',
      hits.length > 0
        ? 'A hit sets the band to `pelna`. The exit code stays 0 unless --strict was passed'
        : 'No rule matched this change',
    ] as ToonValue,
  };

  emitDoc(context.writers, context.format, doc, () => renderMarkdown(doc, hits.map(hitSentence)));
  if (flagBool(context.args, 'strict') && hits.length > 0) return EXIT_ERROR;
  return EXIT_OK;
}

function renderMarkdown(doc: ToonObject, sentences: string[]): string {
  const lines: string[] = [
    `# eyes-on hard rules - ${String(doc.rules_hit)} of ${String(doc.rules_evaluated)} matched`,
    '',
    `Read from \`${String(doc.config_ref ?? doc.config_branch)}\`${doc.config_sha ? ` @ ${String(doc.config_sha)}` : ''}, state: **${String(doc.config_state)}**.`,
    `Matched against all ${String(doc.changed_files)} changed files in ${String(doc.base)}..${String(doc.head)}.`,
  ];
  if (doc.config_detail) {
    lines.push('', `**Unverified.** ${String(doc.config_detail)}`);
  }
  if (sentences.length > 0) {
    lines.push('', '## Hits', '');
    for (const sentence of sentences) lines.push(`- ${sentence}`);
    lines.push('', 'Band: `pelna` - a human reads this change in full.');
  } else {
    lines.push('', 'No hard rule matched this change.');
  }
  lines.push('', `_${(doc.help as string[])[0] ?? ''}._`);
  return lines.join('\n');
}
