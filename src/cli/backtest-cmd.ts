import type { Context } from './context.js';
import { flagString } from './args.js';
import { emitDoc, EXIT_OK, progress, UserFacingError } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import {
  backtest,
  parseSplit,
  CHURN_DECILE_LIFT_TARGET,
  FIX_HISTORY_LIFT_TARGET,
  type SplitResult,
} from '../risk/backtest.js';
import { resolveDefaultBranch } from '../rules/trusted.js';

/**
 * `eyes-on backtest --split <date>` - does the signal actually know anything?
 *
 * The command reports a lift: how much more often the files it would have
 * flagged before the split were fixed after it, compared with the average file.
 * A lift of 1.0 is a signal that knows nothing, and reporting that plainly is
 * the point - a risk score nobody has tested against its own repository is a
 * number with a decimal point and no evidence behind it.
 *
 * Several dates may be given at once (`--split a,b,c`), because one split is an
 * anecdote. The verdict lines compare against the report's stage 1 thresholds
 * so the answer is pass or fail rather than two numbers to eyeball.
 */
export async function backtestCommand(context: Context): Promise<number> {
  const raw = flagString(context.args, 'split');
  if (!raw) {
    throw new UserFacingError('eyes-on backtest needs a split date', [
      'Usage: eyes-on backtest --split YYYY-MM-DD',
      'Several dates at once: --split 2026-03-01,2026-05-01,2026-07-01',
    ]);
  }
  const splits = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const split of splits) {
    try {
      parseSplit(split);
    } catch (error) {
      throw new UserFacingError((error as Error).message, ['Split dates are YYYY-MM-DD, for example 2026-06-01']);
    }
  }

  // The blame cache is shared with `check` and is keyed by commit SHA, so a
  // backtest may read it and add to it: a commit's blame does not depend on
  // which split date asked for it.
  const risk = riskContext(context, { dbMode: 'optional', needRange: false });
  const anchor = resolveDefaultBranch(risk.clonePath, risk.reader, flagString(context.args, 'default-branch')) ?? null;
  const anchorSHA = anchor?.sha ?? risk.reader.resolve('HEAD');
  if (!anchorSHA) {
    throw new UserFacingError(`cannot resolve a commit to replay history from in ${risk.clonePath}`, [
      'Run this from a clone with at least one commit',
    ]);
  }

  const horizonRaw = flagString(context.args, 'horizon');
  const horizonDays = horizonRaw === null ? undefined : Number.parseInt(horizonRaw, 10);
  if (horizonRaw !== null && (!Number.isFinite(horizonDays) || (horizonDays as number) <= 0)) {
    throw new UserFacingError(`--horizon ${horizonRaw} is not a positive number of days`, [
      'Leave --horizon out to measure the outcome up to the branch head',
    ]);
  }

  const results = backtest({
    reader: risk.reader,
    db: risk.db,
    config: risk.trusted.config,
    anchorSHA,
    splits,
    horizonDays,
    onProgress: (message) => progress(context.writers, message),
  });

  const evaluated = results.filter((result) => result.note === null);
  // A verdict is a claim about the splits that measured *that* signal. A split
  // where nothing was flagged, or where nothing was fixed afterwards, carries a
  // null lift and is left out of its own signal's verdict rather than counted
  // as a failure - and the count it rests on is reported beside it, so nobody
  // has to guess how much evidence a `pass` stands on.
  const verdict = (
    pick: (result: SplitResult) => number | null,
    target: number,
  ): { measured: number; pass: boolean } => {
    const lifts = results.map(pick).filter((lift): lift is number => lift !== null);
    return { measured: lifts.length, pass: lifts.length > 0 && lifts.every((lift) => lift >= target) };
  };
  const fixHistory = verdict((result) => result.fix_history.lift, FIX_HISTORY_LIFT_TARGET);
  const fixTouch = verdict((result) => result.fix_touch.lift, FIX_HISTORY_LIFT_TARGET);
  const churnDecile = verdict((result) => result.churn_top_decile.lift, CHURN_DECILE_LIFT_TARGET);

  const doc: ToonObject = {
    splits: results.length,
    evaluated: evaluated.length,
    anchor: anchor ? `${anchor.ref} @ ${anchor.sha.slice(0, 12)}` : anchorSHA.slice(0, 12),
    window_days: risk.trusted.config.history_window_days,
    horizon_days: horizonDays ?? null,
    fix_history_target: FIX_HISTORY_LIFT_TARGET,
    churn_decile_target: CHURN_DECILE_LIFT_TARGET,
    fix_history_measured: fixHistory.measured,
    fix_history_pass: fixHistory.pass,
    fix_touch_measured: fixTouch.measured,
    fix_touch_pass: fixTouch.pass,
    churn_decile_measured: churnDecile.measured,
    churn_decile_pass: churnDecile.pass,
    results: results.map((result) => ({
      split: result.split,
      commit: result.split_commit ? result.split_commit.slice(0, 12) : null,
      population: result.population,
      before_commits: result.before_commits,
      before_fixes: result.before_fix_commits,
      after_commits: result.after_commits,
      after_fixes: result.after_fix_commits,
      base_rate: round(result.base_rate),
      fix_history_flagged: result.fix_history.flagged,
      fix_history_rate: round(result.fix_history.rate),
      fix_history_lift: round(result.fix_history.lift),
      fix_touch_flagged: result.fix_touch.flagged,
      fix_touch_lift: round(result.fix_touch.lift),
      churn_decile_flagged: result.churn_top_decile.flagged,
      churn_decile_rate: round(result.churn_top_decile.rate),
      churn_decile_lift: round(result.churn_top_decile.lift),
      elapsed_ms: result.elapsed_ms,
      note: result.note,
    })) as ToonValue,
    help: [
      'Lift is the post-split fix rate of the flagged files over the fix rate of every code file that existed at the split',
      'A lift of 1.0 means the signal carries no information; the report asks for 2.5 on fix history and 3.0 on the churn top decile',
      'The signal is computed only from commits before the split, and the outcome only from commits after it',
      '`fix_history` is the signal eyes-on actually computes, through blame; `fix_touch` is the cheapest possible version of it, and is reported so the blame step has to earn its cost',
    ] as ToonValue,
  };

  emitDoc(context.writers, context.format, doc, () => renderMarkdown(doc, results));
  return EXIT_OK;
}

function round(value: number): number;
function round(value: number | null): number | null;
function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 100) / 100;
}

function renderMarkdown(doc: ToonObject, results: readonly SplitResult[]): string {
  const lines: string[] = [
    `# eyes-on backtest - ${String(doc.evaluated)} of ${String(doc.splits)} splits evaluated`,
    '',
    `Anchor: \`${String(doc.anchor)}\`. Signal window: ${String(doc.window_days)} days before each split.`,
    '',
    '| split | files | blamed by a fix | lift | touched by a fix | lift | churn decile | lift |',
    '|---|---|---|---|---|---|---|---|',
  ];
  // Every cell is keyed off whether the step behind it actually ran. A group
  // with a null lift flagged nothing, or had nothing to compare against - so
  // its flagged count is a placeholder zero, not a measurement, and printing it
  // would state a number nobody took.
  const cell = (group: { flagged: number; lift: number | null }): string =>
    group.lift === null ? '- | not measured' : `${group.flagged} | ${round(group.lift)}x`;
  const notMeasured = results.filter((result) => result.note !== null);
  for (const result of results) {
    const population = result.split_commit === null ? '-' : String(result.population);
    lines.push(
      `| ${result.split} | ${population} | ${cell(result.fix_history)} | ${cell(result.fix_touch)} | ${cell(result.churn_top_decile)} |`,
    );
  }

  if (notMeasured.length > 0) {
    lines.push('', `## ${notMeasured.length} of ${results.length} splits were not measured`, '');
    for (const result of notMeasured) {
      lines.push(`- **${result.split}** - ${String(result.note)}`);
    }
  }

  // A verdict over no measured split is neither pass nor fail: `fail` would
  // claim a measurement that was never taken, which is the reading this table
  // exists to remove.
  const target = (
    label: string,
    measured: ToonValue | undefined,
    pass: ToonValue | undefined,
    value: ToonValue | undefined,
  ): string =>
    `${label} target ${String(value)}x over ${String(measured)} of ${results.length} splits: **${
      measured === 0 ? 'not measured' : pass ? 'pass' : 'fail'
    }**`;
  lines.push(
    '',
    `${target('Fix-history lift', doc.fix_history_measured, doc.fix_history_pass, doc.fix_history_target)}` +
      ` (blame-free variant over ${String(doc.fix_touch_measured)}: ${
        doc.fix_touch_measured === 0 ? 'not measured' : doc.fix_touch_pass ? 'pass' : 'fail'
      }).` +
      ` ${target('Churn top-decile', doc.churn_decile_measured, doc.churn_decile_pass, doc.churn_decile_target)}.`,
  );

  for (const result of results) {
    // "Went on to be fixed" has to be true of every line beneath the heading,
    // so a file with no post-split fix is not evidence for it.
    const fixed = result.fix_history.examples.filter((example) => example.after > 0);
    if (result.fix_history.lift === null || fixed.length === 0) continue;
    lines.push('', `## ${result.split} - flagged files that went on to be fixed`, '');
    for (const example of fixed) {
      lines.push(`- \`${example.path}\` - ${example.before} fixes before the split, ${example.after} after`);
    }
  }

  lines.push('', `_${(doc.help as string[])[2] ?? ''}._`);
  return lines.join('\n');
}
