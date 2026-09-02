import { userInfo } from 'node:os';
import type { Context } from './context.js';
import { assertMayMutate } from './context.js';
import { flagString } from './args.js';
import { emitDoc, EXIT_OK, EXIT_USAGE, UserFacingError } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { checkByID, checkID, type CheckRow } from '../db/checks.js';
import { allDecisions, latestDecision, recordDecision, type GateAction } from '../db/gate.js';
import { bandLabel, driftProvenanceSentence, unverifiedSentence, type Band } from '../risk/signals.js';

/**
 * `eyes-on axi respond` - the answer to a parked run.
 *
 * A hard rule firing sets the band to `pelna`, which is a statement about the
 * change. The gate is what turns it into a statement about a person: this run
 * stays `must_read` until somebody records that they read it, or waived it and
 * why. That is the difference the report is after (section 5, P2 and P5): the
 * channel label stops being a declaration and becomes evidence.
 *
 * Three properties hold and each is deliberate.
 *
 * **A waiver needs a reason.** `--action waive` without `--reason` is a usage
 * error, not a waiver with an empty field. A ledger of waivers nobody explained
 * is a ledger stage 3 cannot argue with.
 *
 * **Nothing else is unblocked by answering.** No push was held, no pull request
 * was red, no exit code changes. What the answer releases is the eyes-on run
 * itself, and the record is the point.
 *
 * **Decisions accumulate.** A second answer is appended rather than
 * overwriting the first, because "waived on Monday, read in full on Tuesday" is
 * a true sentence about a change and the record has to be able to say it.
 */
export async function respondCommand(context: Context): Promise<number> {
  assertMayMutate(context, 'axi respond');

  const action = parseAction(flagString(context.args, 'action'));
  const reason = normalizeReason(flagString(context.args, 'reason'));
  if (action === 'waive' && reason === null) {
    throw new UserFacingError('a waiver has to say why', [
      'Pass --reason "..." naming what makes this change safe to merge unread',
      'Use --action read instead if a human did read the change',
    ], EXIT_USAGE);
  }

  const risk = riskContext(context, { dbMode: 'required' });
  const db = risk.db;
  if (!db) {
    // `dbMode: 'required'` already refuses a missing state root with a message
    // naming it, so reaching here would be a bug rather than a user's mistake.
    throw new UserFacingError('no eyes-on state database is open', ['Run `eyes-on init` in this repository first']);
  }

  const id = flagString(context.args, 'check-id') ?? checkID(risk.repoId, risk.baseSHA, risk.headSHA);
  const check = checkByID(db, id);
  if (!check) {
    throw new UserFacingError(`no eyes-on check ${id} to respond to`, [
      'Run `eyes-on check` on this change first: a decision is recorded against an assessment, never on its own',
      `The check for ${risk.baseSHA.slice(0, 12)}..${risk.headSHA.slice(0, 12)} would be ${id}`,
    ]);
  }

  const previous = latestDecision(db, id);
  const decidedBy = flagString(context.args, 'by') ?? defaultActor(context);
  const decision = recordDecision(db, { checkId: id, action, reason, decidedBy });
  // Read back rather than asserted: an `unverified` check keeps that status
  // through the gate, so the row is what this run left behind.
  const after = checkByID(db, id);

  const doc: ToonObject = {
    check_id: id,
    // What the gate was before this answer, and what it is now. Both, because
    // an agent that responds twice has to be able to tell that it did.
    gate_was: previous ? 'none' : check.status === 'must_read' ? 'must_read' : 'none',
    gate: 'none',
    status: after?.status ?? 'done',
    unverified: (after ?? check).status === 'unverified',
    action: decision.action,
    reason: decision.reason,
    decided_by: decision.decided_by,
    decided_at: decision.decided_at,
    previous_action: previous?.action ?? null,
    decisions: allDecisions(db, id).map((row) => ({
      action: row.action,
      reason: row.reason,
      decided_by: row.decided_by,
      decided_at: row.decided_at,
    })) as ToonValue,
    branch: check.branch,
    base: check.base_sha.slice(0, 12),
    head: check.head_sha.slice(0, 12),
    score: check.score,
    // The four facts of one assessment travel together: a score with no
    // denominator, or beside a grade nobody named, is a number an agent cannot
    // read. This command measures nothing, so any grade here was carried.
    score_max: check.score_max,
    band: check.band,
    band_label: check.band ? bandLabel(check.band as Band) : null,
    drift: check.drift,
    drift_intent: check.drift_intent,
    drift_provenance: check.drift === null ? 'none' : 'carried',
    drift_sentence: driftProvenanceSentence({
      provenance: check.drift === null ? 'none' : 'carried',
      grade: check.drift,
      intent: check.drift_intent,
    }),
    exit_code: EXIT_OK,
    help: helpLines(check, previous !== undefined) as ToonValue,
  };

  emitDoc(context.writers, context.format, doc, () => renderMarkdown(doc));
  return EXIT_OK;
}

function helpLines(check: CheckRow, wasAnswered: boolean): string[] {
  const lines: string[] = [];
  if (check.status === 'unverified') {
    lines.push(`${unverifiedSentence()} The decision is recorded and that stays true, so the check keeps the status`);
  }
  if (check.status !== 'must_read' && !wasAnswered) {
    lines.push(
      'This run was not parked: no hard rule matched it. The decision is recorded anyway, because a deliberate answer about a change nobody had to read is still a fact about that change',
    );
  }
  if (wasAnswered) {
    lines.push('This change had already been answered; the new decision is appended and the earlier one is kept');
  }
  lines.push('Answering releases the eyes-on run and nothing else: no exit code, push or pull request was ever held by it');
  lines.push('By default this answers the check for the current base..head; pass --check-id <id> to answer another one, and --by <name> to record who did');
  lines.push('Run `eyes-on spotlight` for the fragments to read, or `eyes-on comment --pr <n>` to publish the result');
  return lines;
}

function parseAction(raw: string | null): GateAction {
  if (raw === 'read' || raw === 'waive') return raw;
  throw new UserFacingError(
    raw === null ? 'respond needs --action' : `unknown action ${raw}`,
    [
      'Use --action read when a human read the change',
      'Use --action waive --reason "..." when it is going in unread and you can say why',
    ],
    EXIT_USAGE,
  );
}

function normalizeReason(raw: string | null): string | null {
  const trimmed = raw?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Who is answering.
 *
 * `EYES_ON_ACTOR` first, because an agent driving this command is not the
 * account it happens to be running under and the ledger should say which agent
 * it was. The account name is the fallback; it is at least true.
 */
function defaultActor(context: Context): string {
  const named = context.env.EYES_ON_ACTOR?.trim();
  if (named && named.length > 0) return named;
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

function renderMarkdown(doc: ToonObject): string {
  const reason = doc.reason ? ` - ${String(doc.reason)}` : '';
  return [
    `# eyes-on gate answered: ${String(doc.action)}${reason}`,
    '',
    `Check \`${String(doc.check_id)}\` on \`${String(doc.branch)}\`, ${String(doc.base)}..${String(doc.head)}.`,
    `Recorded by ${String(doc.decided_by)}. Status is now \`${String(doc.status)}\`.`,
    '',
    (doc.help as string[])[0] ?? '',
  ].join('\n');
}
