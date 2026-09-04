import type { Context } from './context.js';
import { flagDuration, flagString } from './args.js';
import { emitDoc, progress, EXIT_OK, EXIT_USAGE, UserFacingError } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { resolveDefaultBranch } from '../rules/trusted.js';
import { readLedger, recordsFor } from '../ledger/ledger.js';
import { measureLeaks, type LeaksReport } from '../ledger/leaks.js';
import {
  exclusionHelpLines,
  exclusionOutlook,
  EXCLUSION_KINDS,
  DEFAULT_SINCE_SECONDS,
  DEFAULT_WINDOW_SECONDS,
} from '../ledger/population.js';
import { MIN_MERGES_PER_CHANNEL } from '../ledger/sample.js';

/**
 * `eyes-on leaks` - what letting a change through unread actually costs, per
 * channel.
 *
 * The research report calls this the measure that must not be skipped: without
 * it, "should the threshold move?" has no evidence behind it in either
 * direction. `src/ledger/leaks.ts` holds the measurement and the reasoning; this
 * file is the surface, and it owns three things the measurement does not.
 *
 * **There is one variant and no flag chooses it.** The file-level variant - "a
 * later fix touched a file this change touched" - has a base rate of 45-73% on
 * the reference material, which makes every channel score nearly the same and
 * moves no threshold. It is not implemented, and the flag names by which
 * somebody might reach for it are **refused by name** rather than ignored: a
 * flag silently dropped would leave a caller believing they got the variant
 * they asked for.
 *
 * **The header says what the sample supports.** Below a hundred merges in a
 * channel the rates are directional, and the sentence saying so comes from
 * `src/ledger/sample.ts` so that `calibrate` cannot say something weaker.
 *
 * **It blocks nothing.** Exit 0 always. There is no `--strict` here at all: a
 * register is evidence about the past, and there is no state of it that should
 * fail anybody's build.
 */

/**
 * Flags that would be asking for the file-level variant.
 *
 * Refused by name, with the base rate in the message, so the answer is about
 * the measurement rather than about the spelling of a flag. Ignoring them would
 * hand back a line-variant number under a file-variant flag, which is the
 * worst of the three possible behaviours.
 */
const FILE_VARIANT_FLAGS = ['file-level', 'files', 'variant', 'file'];

export async function leaksCommand(context: Context): Promise<number> {
  refuseFileVariant(context);

  const windowSeconds =
    flagDuration(context.args, 'window', {
      what: 'a length of time',
      help: [
        'Pass a number of hours, days or weeks, for example `--window 14d` or `--window 2w`',
        'The window is how long after a merge a fix still counts as that merge leaking',
      ],
      min: 3_600,
    }) ?? DEFAULT_WINDOW_SECONDS;
  const sinceSeconds =
    flagDuration(context.args, 'since', {
      what: 'a length of time',
      help: [
        'Pass a number of hours, days or weeks, for example `--since 90d` or `--since 12w`',
        'It is how far back the register and the branch history are read',
      ],
      min: 3_600,
    }) ?? DEFAULT_SINCE_SECONDS;

  // The blame cache is shared with `check` and keyed by commit SHA, so this
  // reads it and adds to it: a commit's blame does not depend on who asked.
  const risk = riskContext(context, { dbMode: 'optional', needRange: false });
  const anchor = resolveDefaultBranch(risk.clonePath, risk.reader, flagString(context.args, 'default-branch'));
  const anchorSHA = anchor?.sha ?? risk.reader.resolve('HEAD');
  if (!anchorSHA) {
    throw new UserFacingError(`cannot resolve a branch to read history from in ${risk.clonePath}`, [
      'Run this from a clone with at least one commit',
      'Pass --default-branch <ref> to name the branch pull requests merge into',
    ]);
  }

  const ledger = readLedger(context.paths);
  const records = recordsFor(ledger.records, risk.repoId);
  const now = Math.floor(Date.now() / 1000);

  const report = measureLeaks({
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

  const doc = renderDoc(report, {
    ledgerAbsent: ledger.absent,
    ledgerSkipped: ledger.skipped,
    ledgerPath: context.paths.ledger,
    anchor: anchor ? `${anchor.ref} @ ${anchor.sha.slice(0, 12)}` : anchorSHA.slice(0, 12),
    windowSeconds,
    sinceSeconds,
  });
  emitDoc(context.writers, context.format, doc, () => renderMarkdown(report, doc));
  // Always. A register reports on the past and holds nothing up.
  return EXIT_OK;
}

/**
 * Refuses a request for the variant that does not exist.
 *
 * The message carries the base rate, because the honest answer to "why can I
 * not have the cheap one" is a number rather than a policy.
 */
function refuseFileVariant(context: Context): void {
  const asked = FILE_VARIANT_FLAGS.filter((name) => context.args.flags.has(name));
  if (asked.length === 0) return;
  throw new UserFacingError(
    `eyes-on leaks reports the line-level variant only, so there is no --${asked[0] as string} to pass`,
    [
      'A leak is a later fix whose blame, taken on that fix\'s parent, names the merge commit of a registered change',
      'The file-level variant - "a later fix touched a file this change touched" - has a base rate of 45-73% on the reference material, so every channel scores nearly the same and no threshold can be argued from it',
      'It is not implemented and there is no flag that reaches it; run `eyes-on leaks [--window 14d] [--since 90d]`',
    ],
    EXIT_USAGE,
  );
}

interface DocOptions {
  ledgerAbsent: boolean;
  ledgerSkipped: number;
  ledgerPath: string;
  anchor: string;
  windowSeconds: number;
  sinceSeconds: number;
}

function renderDoc(report: LeaksReport, options: DocOptions): ToonObject {
  return {
    // Named in every payload, so a reader never has to ask which measurement
    // produced the number. There is no other value this can take.
    variant: report.variant,
    anchor: options.anchor,
    window: days(options.windowSeconds),
    since: days(options.sinceSeconds),
    // What the sample supports, at the top, where the numbers are read.
    directional: !report.sample.decisive,
    sample_sentence: report.sample.sentence,
    merges: report.merges,
    leaked: report.leaked,
    leak_rate: round(report.base_rate),
    channels: report.channels.map((row) => ({
      band: row.band,
      merges: row.merges,
      leaked: row.leaked,
      leak_rate: round(row.rate),
      // Per row, because a table whose caveat is only in the header invites
      // reading one row out of it.
      directional: row.merges < MIN_MERGES_PER_CHANNEL,
    })) as ToonValue,
    leaks: report.leaks.map((leak) => ({
      pr: leak.pr,
      band: leak.band,
      merge: leak.merge_sha.slice(0, 12),
      fix: leak.fix_sha.slice(0, 12),
      fix_subject: leak.fix_subject,
      days_after_merge: leak.days_after_merge,
      blamed_lines: leak.blamed_lines,
    })) as ToonValue,
    // Registered merges that are not in the denominator, one row each with the
    // reason. A population narrowed silently is a rate nobody can check.
    excluded: report.excluded.map((entry) => ({
      pr: entry.pr,
      merge: entry.merge_sha === null ? null : entry.merge_sha.slice(0, 12),
      reason: entry.reason,
      // Whether waiting alone puts this row back in the denominator. Read from
      // the reason's own definition, never from where it was tested.
      permanent: EXCLUSION_KINDS[entry.reason].permanent,
    })) as ToonValue,
    // Rows the register holds for this repository, beside the `merges` above
    // that a rate may be divided by. A reader of a zero denominator has to be
    // able to tell an empty register from a full one nothing is measurable in.
    register_rows: report.population.registered,
    unverified: report.unverified,
    parked: report.parked,
    merged_on_branch: report.coverage.merged_on_branch,
    registered: report.coverage.registered,
    ledger: options.ledgerPath,
    ledger_absent: options.ledgerAbsent,
    ledger_lines_skipped: options.ledgerSkipped,
    fixes_considered: report.fixes_considered,
    blames_cached: report.blames_cached,
    blames_computed: report.blames_computed,
    exit_code: EXIT_OK,
    help: helpLines(report, options) as ToonValue,
  };
}

function helpLines(report: LeaksReport, options: DocOptions): string[] {
  const lines: string[] = [];
  if (options.ledgerAbsent) {
    lines.push(
      `There is no register at ${options.ledgerPath} yet: run \`eyes-on label --pr <n>\` after a merge and this table fills in`,
    );
  }
  if (options.ledgerSkipped > 0) {
    lines.push(
      `${options.ledgerSkipped} line${options.ledgerSkipped === 1 ? '' : 's'} of the register could not be read as a record of this version and ${options.ledgerSkipped === 1 ? 'was' : 'were'} skipped`,
    );
  }
  const uncovered = report.coverage.merged_on_branch - report.coverage.registered;
  if (uncovered > 0) {
    lines.push(
      `${uncovered} of the ${report.coverage.merged_on_branch} pull requests the branch landed in this window are not in the register; the rates above are over the ${report.merges} merge${report.merges === 1 ? '' : 's'} in the denominator, and the lines below say how it reached that number`,
    );
  }
  // A branch whose subjects carry no trailing `(#N)` - one that merges with
  // `--no-ff`, writes "Merge pull request #7 from ...", or has simply landed
  // nothing inside `--since` - lands nothing this walk can count, and a
  // coverage ratio against nothing is not a small number, it is no number. The
  // walk is evidence for that and for nothing else: why the register's rows are
  // there is a question about the rows, and an empty walk answers it for none
  // of the three ways a row can have been placed.
  if (report.coverage.merged_on_branch === 0 && report.population.registered > 0) {
    lines.push(
      `No commit the branch landed in this window carries a \`(#N)\` subject, so there is nothing to measure coverage against; the register holds ${report.population.registered} row${report.population.registered === 1 ? '' : 's'} for this repository`,
    );
  }
  // One line per reason present, generated from the same table that says
  // whether the reason is one time undoes. Written per reason here is what let
  // a structural exclusion carry a promise of return for a whole review round.
  lines.push(...exclusionHelpLines(report.excluded, days(options.windowSeconds)));
  if (report.unverified > 0) {
    lines.push(
      `${report.unverified} of the merges in this table were assessed while the trusted configuration could not be read, so their channel is a floor and they may belong in a higher one`,
    );
  }
  if (report.parked > 0) {
    lines.push(
      `${report.parked} of them merged with the gate still parked: a hard rule fired and no decision answers it`,
    );
  }
  lines.push(report.sample.sentence);
  lines.push(
    'A leak is a later fix commit whose blame, taken on that fix\'s parent, names the merge commit of a registered change. Only the line-level variant exists: the file-level one has a base rate of 45-73% and can argue for no threshold',
  );
  lines.push('Run `eyes-on calibrate` to sweep thresholds over this same register');
  lines.push('This command exits 0 whatever the numbers are: the register reports on the past and holds nothing up');
  return lines;
}

function renderMarkdown(report: LeaksReport, doc: ToonObject): string {
  const lines: string[] = [
    `# eyes-on leaks - ${report.leaked} of ${report.merges} registered merges leaked inside ${String(doc.window)}`,
    '',
    report.sample.sentence,
    '',
    `Line-level variant only. Anchor \`${String(doc.anchor)}\`, history since ${String(doc.since)}, register \`${String(doc.ledger)}\`.`,
    '',
    '| channel | merges | leaked | rate | |',
    '|---|---|---|---|---|',
  ];
  for (const row of report.channels) {
    const rate = row.rate === null ? '-' : `${Math.round(row.rate * 100)}%`;
    const mark = row.merges < MIN_MERGES_PER_CHANNEL ? `directional (< ${MIN_MERGES_PER_CHANNEL})` : '';
    lines.push(`| \`${row.band}\` | ${row.merges} | ${row.leaked} | ${rate} | ${mark} |`);
  }

  if (report.leaks.length > 0) {
    lines.push('', '## The leaks', '');
    for (const leak of report.leaks) {
      lines.push(
        `- #${leak.pr} (\`${leak.band}\`, merged as \`${leak.merge_sha.slice(0, 12)}\`) - fixed ${leak.days_after_merge} days later by \`${leak.fix_sha.slice(0, 12)}\` "${leak.fix_subject}", ${leak.blamed_lines} blamed line${leak.blamed_lines === 1 ? '' : 's'}`,
      );
    }
  }

  if (report.excluded.length > 0) {
    lines.push('', '## Registered merges outside the denominator, and why', '');
    for (const entry of report.excluded) {
      // The reason's own outlook, like every other surface. Writing the promise
      // here from the `permanent` flag is the construct three rounds removed
      // everywhere else, and it showed: it named no window while the help line
      // below it did.
      lines.push(
        `- #${entry.pr}${entry.merge_sha ? ` (\`${entry.merge_sha.slice(0, 12)}\`)` : ''}: ${entry.reason}. ` +
          exclusionOutlook(entry.reason, { plural: false, windowLabel: String(doc.window) }),
      );
    }
  }

  lines.push(
    '',
    report.coverage.merged_on_branch === 0
      ? `Coverage: no commit the branch landed in this window carries a \`(#N)\` subject, so there is nothing to measure against. The register holds ${report.population.registered} row${report.population.registered === 1 ? '' : 's'} for this repository.`
      : `Coverage: ${report.coverage.registered} of the ${report.coverage.merged_on_branch} pull requests the branch landed in this window are in the register.`,
    '',
    '---',
    '',
  );
  // Every help line, not a tail of them: the caveats about an unverified band,
  // a gate nobody answered and a population narrowed by an exclusion are in
  // this list, and a Markdown reader who saw only the last few would be reading
  // the table without them.
  for (const line of doc.help as string[]) lines.push(`- ${line}`);
  return lines.join('\n');
}

/** A span of seconds as the flag that produced it would be written. */
function days(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${seconds}s`;
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1000) / 1000;
}
