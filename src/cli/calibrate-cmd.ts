import type { Context } from './context.js';
import { flagDuration, flagString } from './args.js';
import { emitDoc, progress, EXIT_OK, UserFacingError } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { resolveDefaultBranch } from '../rules/trusted.js';
import { readLedger, recordsFor } from '../ledger/ledger.js';
import { measureLeaks } from '../ledger/leaks.js';
import { calibrate, type CalibrateReport, type GridRow } from '../ledger/calibrate.js';
import { maxScore } from '../risk/signals.js';
import { DEFAULT_SINCE_SECONDS, DEFAULT_WINDOW_SECONDS } from '../ledger/population.js';

/**
 * `eyes-on calibrate` - the threshold sweep over the register.
 *
 * It answers one question: for every candidate pair of thresholds, what would
 * each channel have carried and how much of it would have leaked. That is the
 * only way a threshold moves in this product - the constants in
 * `risk/repoconfig.ts` are the report's, and changing one is argued from
 * measured history rather than from taste.
 *
 * The sweep runs over `leaks`' own measurement, not a second one of its own -
 * its leaks *and* the population those leaks were divided by - so the two
 * commands cannot report different leak counts, or different channel sizes, for
 * the same register. `src/ledger/calibrate.ts` holds the arithmetic and the
 * four things that decide whether it means anything.
 *
 * **It proposes nothing the register can support.** The row this history points
 * at is presented under the caveat `leaks` prints, from the same
 * `src/ledger/sample.ts` - worded about the channels these thresholds would
 * produce rather than the ones the denominator has merges in, because a pair
 * can move merges into a band that is empty today - and when the
 * register holds no leak at all there is no row to point at and the command
 * says so rather than ranking a tie. Nothing here writes a configuration file:
 * the candidate is an argument to be made to a human, and `.eyes-on.yml` is
 * read from the default branch, which is the one place eyes-on will not write.
 */
export async function calibrateCommand(context: Context): Promise<number> {
  const windowSeconds =
    flagDuration(context.args, 'window', {
      what: 'a length of time',
      help: ['Pass a number of hours, days or weeks, for example `--window 14d`'],
      min: 3_600,
    }) ?? DEFAULT_WINDOW_SECONDS;
  const sinceSeconds =
    flagDuration(context.args, 'since', {
      what: 'a length of time',
      help: ['Pass a number of hours, days or weeks, for example `--since 90d`'],
      min: 3_600,
    }) ?? DEFAULT_SINCE_SECONDS;

  const risk = riskContext(context, { dbMode: 'optional', needRange: false });
  const anchor = resolveDefaultBranch(risk.clonePath, risk.reader, flagString(context.args, 'default-branch'));
  const anchorSHA = anchor?.sha ?? risk.reader.resolve('HEAD');
  if (!anchorSHA) {
    throw new UserFacingError(`cannot resolve a branch to read history from in ${risk.clonePath}`, [
      'Run this from a clone with at least one commit',
    ]);
  }

  const ledger = readLedger(context.paths);
  const records = recordsFor(ledger.records, risk.repoId);
  const now = Math.floor(Date.now() / 1000);

  const leaks = measureLeaks({
    reader: risk.reader,
    db: risk.db,
    config: risk.trusted.config,
    records,
    anchorSHA,
    sinceSeconds: now - sinceSeconds,
    windowSeconds,
    nowSeconds: now,
    onProgress: (message) => progress(context.writers, message),
  });

  // The scale the grid runs on is the one the current weights produce. Records
  // scored under another maximum are set aside and counted rather than mixed
  // in: a threshold compared with a score computed under different weights is
  // a comparison of two different numbers wearing one name.
  const report = calibrate({
    // The population `leaks` divided by, not the whole register. Two commands
    // reporting different channel sizes for one register would be two
    // instruments rather than one, and the rate the candidate is held at would
    // be diluted by merges no leak could ever have been attributed to.
    records: leaks.eligible,
    leaks: leaks.leaks,
    excluded: leaks.excluded,
    current: risk.trusted.config.thresholds,
    scoreMax: maxScore(risk.trusted.config),
  });

  const doc = renderDoc(report, {
    anchor: anchor ? `${anchor.ref} @ ${anchor.sha.slice(0, 12)}` : anchorSHA.slice(0, 12),
    ledgerAbsent: ledger.absent,
    ledgerSkipped: ledger.skipped,
    ledgerPath: context.paths.ledger,
    windowDays: Math.round(windowSeconds / 86_400),
    sinceDays: Math.round(sinceSeconds / 86_400),
    configState: risk.trusted.state,
  });
  emitDoc(context.writers, context.format, doc, () => renderMarkdown(report, doc));
  return EXIT_OK;
}

interface DocOptions {
  anchor: string;
  ledgerAbsent: boolean;
  /** Register lines this build could not read. Reported here as `leaks` reports
   *  them: a sweep short by those rows and silent about it is the same register
   *  answered two ways by two commands. */
  ledgerSkipped: number;
  ledgerPath: string;
  windowDays: number;
  sinceDays: number;
  configState: string;
}

/**
 * The rows worth printing.
 *
 * The whole grid is in the payload's `rows_considered` count and not in the
 * payload itself: a few hundred rows of which most are duplicates of each
 * other's channel assignment is not a thing anybody reads. What is printed is
 * the frontier - for each distinct `auto` channel size, the row that leaks
 * least - plus the current pair and the candidate, which are always present.
 */
function frontier(report: CalibrateReport): GridRow[] {
  const best = new Map<number, GridRow>();
  for (const row of report.rows) {
    const seen = best.get(row.auto_merges);
    if (!seen || row.auto_leaked < seen.auto_leaked) best.set(row.auto_merges, row);
  }
  const rows = [...best.values()];
  for (const row of [report.current, report.candidate]) {
    if (row && !rows.some((entry) => entry.read_fragments === row.read_fragments && entry.full_review === row.full_review)) {
      rows.push(row);
    }
  }
  return rows.sort((a, b) => a.read_share - b.read_share || a.read_fragments - b.read_fragments);
}

function renderDoc(report: CalibrateReport, options: DocOptions): ToonObject {
  const rows = frontier(report);
  return {
    merges: report.merges,
    leaked: report.leaked,
    score_max: report.score_max,
    anchor: options.anchor,
    window_days: options.windowDays,
    since_days: options.sinceDays,
    directional: !report.sample.decisive,
    sample_sentence: report.sample.sentence,
    current_read_fragments: report.current?.read_fragments ?? null,
    current_full_review: report.current?.full_review ?? null,
    current_auto_merges: report.current?.auto_merges ?? null,
    current_auto_leaked: report.current?.auto_leaked ?? null,
    current_auto_rate: round(report.current?.auto_rate ?? null),
    current_read_share: round(report.current?.read_share ?? null),
    // The pair this history points at, never called a recommendation: the
    // sample sentence above says what the register can carry.
    candidate_read_fragments: report.candidate?.read_fragments ?? null,
    candidate_full_review: report.candidate?.full_review ?? null,
    candidate_auto_rate: round(report.candidate?.auto_rate ?? null),
    candidate_read_share: round(report.candidate?.read_share ?? null),
    candidate_blocked: report.candidate_blocked,
    rows_considered: report.rows.length,
    rows: rows.map((row) => ({
      read_fragments: row.read_fragments,
      full_review: row.full_review,
      auto_merges: row.auto_merges,
      auto_leaked: row.auto_leaked,
      auto_rate: round(row.auto_rate),
      read_share: round(row.read_share),
      current: row.current,
      candidate:
        report.candidate !== null &&
        row.read_fragments === report.candidate.read_fragments &&
        row.full_review === report.candidate.full_review,
    })) as ToonValue,
    // Rows the sweep could not include, each with the reason. These are the
    // three ways a recorded score fails to be comparable with a threshold.
    rule_forced: report.rule_forced,
    unscored: report.unscored,
    other_scales: report.other_scales as unknown as ToonValue,
    outside_denominator: report.outside_denominator as unknown as ToonValue,
    ledger: options.ledgerPath,
    ledger_absent: options.ledgerAbsent,
    ledger_lines_skipped: options.ledgerSkipped,
    config_state: options.configState,
    exit_code: EXIT_OK,
    help: helpLines(report, options) as ToonValue,
  };
}

function helpLines(report: CalibrateReport, options: DocOptions): string[] {
  const lines: string[] = [];
  if (options.ledgerAbsent) {
    lines.push(`There is no register at ${options.ledgerPath} yet: run \`eyes-on label --pr <n>\` after a merge`);
  }
  if (options.ledgerSkipped > 0) {
    lines.push(
      `${options.ledgerSkipped} line${options.ledgerSkipped === 1 ? '' : 's'} of the register could not be read as a record of this version and ${options.ledgerSkipped === 1 ? 'was' : 'were'} skipped, so this sweep is short by ${options.ledgerSkipped === 1 ? 'it' : 'them'}`,
    );
  }
  if (report.candidate_blocked !== null) lines.push(report.candidate_blocked);
  if (report.rule_forced > 0) {
    lines.push(
      `${report.rule_forced} of the merges are held at \`pelna\` by a hard rule at every pair on the grid: a threshold does not move a change a rule decided`,
    );
  }
  if (report.unscored > 0) {
    lines.push(`${report.unscored} registered merges carry no score, so no threshold can band them and they are outside the sweep`);
  }
  const outside = report.outside_denominator.reduce((sum, entry) => sum + entry.merges, 0);
  if (outside > 0) {
    lines.push(
      `${outside} registered merge${outside === 1 ? ' is' : 's are'} outside the leak denominator and outside this sweep (${report.outside_denominator
        .map((entry) => `${entry.merges} ${entry.reason}`)
        .join(', ')}): a pair of thresholds is ranked on what leaked, so the sweep runs over exactly the merges \`eyes-on leaks\` could attribute a leak to`,
    );
  }
  const setAside = report.other_scales.reduce((sum, scale) => sum + scale.merges, 0);
  if (setAside > 0) {
    lines.push(
      `${setAside} registered merges were scored under a different maximum than the current ${report.score_max} and are outside the sweep: a score is only comparable with a threshold under the weights it was computed with`,
    );
  }
  // Said once, in the header the Markdown opens with and in `sample_sentence`.
  lines.push(
    'The objective is the research report\'s: hold the `auto` channel at or below the leak rate it has now, and pay the least human reading for it',
  );
  lines.push('Nothing is written: the thresholds live in `.eyes-on.yml` on the default branch, which eyes-on reads and never writes');
  lines.push('Run `eyes-on leaks` for the channel table this sweep is computed from');
  return lines;
}

function renderMarkdown(report: CalibrateReport, doc: ToonObject): string {
  const current = report.current;
  const lines: string[] = [
    `# eyes-on calibrate - ${report.merges} registered merges, ${report.leaked} of them leaked`,
    '',
    report.sample.sentence,
    '',
  ];
  if (current) {
    lines.push(
      `In force now: **${current.read_fragments} / ${current.full_review}** of at most ${report.score_max}. ` +
        `The \`auto\` channel carries ${current.auto_merges} merges, ${current.auto_leaked} of which leaked` +
        `${current.auto_rate === null ? '' : ` (${Math.round(current.auto_rate * 100)}%)`}, ` +
        `and ${Math.round(current.read_share * 100)}% of merges go to a human.`,
      '',
    );
  }
  if (report.candidate) {
    lines.push(
      `The row this history points at: **${report.candidate.read_fragments} / ${report.candidate.full_review}** - ` +
        `${report.candidate.auto_rate === null ? 'no' : `${Math.round(report.candidate.auto_rate * 100)}%`} leak rate in \`auto\`, ` +
        `${Math.round(report.candidate.read_share * 100)}% of merges read. This is an argument to make to a human, not a setting eyes-on will write.`,
      '',
    );
  } else if (report.candidate_blocked) {
    lines.push(`**No candidate.** ${report.candidate_blocked}`, '');
  }

  lines.push(
    `| read / full | auto merges | auto leaked | auto rate | read share | |`,
    '|---|---|---|---|---|---|',
  );
  for (const row of (doc.rows as unknown as { read_fragments: number; full_review: number; auto_merges: number; auto_leaked: number; auto_rate: number | null; read_share: number; current: boolean; candidate: boolean }[])) {
    const mark = [row.current ? 'in force' : '', row.candidate ? 'candidate' : ''].filter(Boolean).join(', ');
    const rate = row.auto_rate === null ? '-' : `${Math.round(row.auto_rate * 100)}%`;
    lines.push(
      `| ${row.read_fragments} / ${row.full_review} | ${row.auto_merges} | ${row.auto_leaked} | ${rate} | ${Math.round(row.read_share * 100)}% | ${mark} |`,
    );
  }

  lines.push(
    '',
    `_${report.rows.length} pairs swept at a step of 5 over a maximum score of ${report.score_max}; the table shows the frontier - for each size of the \`auto\` channel, the pair that leaks least - plus the pair in force and the candidate._`,
    '',
  );
  // Every help line, not a tail of them: the caveats about an unverified band,
  // a gate nobody answered and a population narrowed by an exclusion are in
  // this list, and a Markdown reader who saw only the last few would be reading
  // the table without them.
  for (const line of doc.help as string[]) lines.push(`- ${line}`);
  return lines.join('\n');
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}
