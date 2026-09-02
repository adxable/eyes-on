import { createHash } from 'node:crypto';
import type { Database } from './db.js';
import type { DriftResult } from '../spot/drift.js';
import type { Spot } from '../spot/spotlight.js';

/**
 * The `must_read` gate, and the records that make it evidence.
 *
 * A hard rule firing already sets the band to `pelna`. The gate is what turns
 * that from a label into a decision somebody made: the check is **parked** -
 * `status = 'must_read'` - until an agent or a human answers with
 * `eyes-on axi respond --action read` or `--action waive --reason "..."`, and
 * the answer, its reason and who gave it are written down.
 *
 * Two properties are the report's and are load-bearing.
 *
 * **The park blocks nothing but eyes-on.** No exit code changes, no push is
 * held, no pull request goes red. A parked check is a check whose decision has
 * not been recorded yet, and `comment` says so on the pull request. That is the
 * whole of it: eyes-on directs attention and has no lever to pull.
 *
 * **A waiver must carry a reason.** A waiver without one records that somebody
 * pressed a button, which is exactly the thing the ledger in stage 3 is meant
 * to be able to argue with. The reason is required by the command, not by
 * convention.
 */

export type GateAction = 'read' | 'waive';

export interface DecisionRow {
  check_id: string;
  action: string;
  reason: string | null;
  decided_by: string | null;
  decided_at: number;
  /** The hard-rule hits this decision answered, as `hitsFingerprint` names
   *  them. Null on a row written before eyes-on recorded it, which answers no
   *  set of hits: what a person was shown is exactly what is not known. */
  hits_fingerprint: string | null;
  /** The trusted configuration those hits came from. */
  config_sha: string | null;
}

/** One hard-rule hit: the glob that fired and the file it matched. */
export interface GateHit {
  glob: string;
  file: string;
}

/**
 * The identity of a set of hard-rule hits.
 *
 * A decision answers the hits a person was actually shown, so it is recorded
 * against them rather than against the check alone. Order does not matter and
 * duplicates do not, which is why the pairs are sorted and the digest is taken
 * of a structured encoding rather than of a joined string: a glob or a path may
 * contain any separator.
 */
export function hitsFingerprint(hits: readonly GateHit[]): string {
  const pairs = hits
    .map((hit) => [hit.glob, hit.file] as const)
    .sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])));
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex').slice(0, 16);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The hard-rule hits recorded for a check, one row per matched file. */
export function recordedHits(db: Database, checkId: string): GateHit[] {
  return db.all<GateHit>('SELECT glob, file FROM hits WHERE check_id = ? ORDER BY glob, file', checkId);
}

/** Every decision recorded for a check, newest first, whatever it answered. */
export function latestDecision(db: Database, checkId: string): DecisionRow | undefined {
  return db.get<DecisionRow>(
    'SELECT * FROM decisions WHERE check_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1',
    checkId,
  );
}

/**
 * The decision that answers these hits, or undefined while they are unanswered.
 *
 * A decision is evidence about the rules it was given against and about nothing
 * else. An answer recorded when no rule had fired - which `respond` accepts,
 * and which an unreadable trusted configuration produces for every change -
 * must not close a gate that appears afterwards, or the pull request publishes
 * a waiver against a rule nobody was ever shown. So the gate asks whether the
 * hits in front of it have been answered, not whether the check has.
 *
 * The newest wins among those that match: a change waived, reassessed and read
 * in full keeps both rows and reports the latest.
 */
export function decisionCovering(db: Database, checkId: string, hits: readonly GateHit[]): DecisionRow | undefined {
  return db.get<DecisionRow>(
    'SELECT * FROM decisions WHERE check_id = ? AND hits_fingerprint = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1',
    checkId,
    hitsFingerprint(hits),
  );
}

/** The same question asked of the hits already recorded for the check, for the
 *  surfaces that read a row rather than compute an assessment. */
export function recordedDecisionCovering(db: Database, checkId: string): DecisionRow | undefined {
  return decisionCovering(db, checkId, recordedHits(db, checkId));
}

export function allDecisions(db: Database, checkId: string): DecisionRow[] {
  return db.all<DecisionRow>('SELECT * FROM decisions WHERE check_id = ? ORDER BY decided_at, rowid', checkId);
}

/**
 * Records a decision and releases the park.
 *
 * Append-only: an earlier decision is never rewritten, because "this was waived
 * and later read in full" is a true sentence about a change and the ledger has
 * to be able to say it. The check's status moves to `done`, which is what
 * un-parks it.
 *
 * A check recorded `unverified` keeps that status. `statusFor` gives it
 * precedence over the gate for a reason - eyes-on could not read the trusted
 * config, so it never evaluated the rules a human would be sent to - and
 * answering a gate says what somebody decided, not that an unreadable
 * configuration became readable.
 */
export function recordDecision(
  db: Database,
  options: {
    checkId: string;
    action: GateAction;
    reason: string | null;
    decidedBy: string;
    /** The hits this answer was given against, and the configuration they came
     *  from. A decision that does not carry them answers nothing later. */
    hits: readonly GateHit[];
    configSha: string | null;
  },
): DecisionRow {
  const now = Math.floor(Date.now() / 1000);
  const fingerprint = hitsFingerprint(options.hits);
  db.run(
    `INSERT INTO decisions (check_id, action, reason, decided_by, decided_at, hits_fingerprint, config_sha)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    options.checkId,
    options.action,
    options.reason,
    options.decidedBy,
    now,
    fingerprint,
    options.configSha,
  );
  db.run(
    "UPDATE checks SET status = CASE WHEN status = 'unverified' THEN status ELSE ? END, updated_at = ? WHERE id = ?",
    'done',
    now,
    options.checkId,
  );
  return {
    check_id: options.checkId,
    action: options.action,
    reason: options.reason,
    decided_by: options.decidedBy,
    decided_at: now,
    hits_fingerprint: fingerprint,
    config_sha: options.configSha,
  };
}

/** Replaces the fragments recorded for a check. A re-run of `spotlight` on the
 *  same head is a new answer to the same question, not a second one. */
export function recordSpots(db: Database, checkId: string, spots: readonly Spot[]): void {
  db.run('DELETE FROM spots WHERE check_id = ?', checkId);
  for (const spot of spots) {
    db.run(
      'INSERT INTO spots (check_id, file, line, category, why, weight, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      checkId,
      spot.file,
      spot.line,
      spot.category,
      spot.why,
      spot.weight,
      spot.source,
    );
  }
}

export interface SpotRow {
  check_id: string;
  file: string;
  line: number | null;
  category: string | null;
  why: string | null;
  weight: number | null;
  source: string;
}

export function spotsFor(db: Database, checkId: string): SpotRow[] {
  return db.all<SpotRow>('SELECT * FROM spots WHERE check_id = ? ORDER BY weight DESC, file, line', checkId);
}

/**
 * Records a grade this run measured, the intent it answers, and its two lists.
 *
 * **Only a run that measured a grade may call this**, and every caller checks
 * before it does: the write replaces the two lists, so a call with nothing
 * measured would delete the lists of a measurement taken of this very
 * base..head. Not measuring is not changing. A row whose grade no longer
 * answers the question being asked goes through `supersedeDrift` instead, which
 * says so rather than pretending a measurement happened.
 *
 * The intent is written beside the grade because the grade measures the pair
 * (diff, intent) while the row is keyed on (repository, base, head).
 */
export function recordDrift(db: Database, checkId: string, drift: DriftResult, intent: string | null): void {
  db.run(
    'UPDATE checks SET drift = ?, drift_intent = ?, updated_at = ? WHERE id = ?',
    drift.grade,
    intent,
    Math.floor(Date.now() / 1000),
    checkId,
  );
  db.run('DELETE FROM drift_items WHERE check_id = ?', checkId);
  const write = (kind: string, items: readonly string[]): void => {
    for (const [position, item] of items.entries()) {
      db.run(
        'INSERT INTO drift_items (check_id, kind, position, item) VALUES (?, ?, ?, ?)',
        checkId,
        kind,
        position,
        item,
      );
    }
  };
  write('missing_from_diff', drift.missing_from_diff);
  write('unrequested_in_diff', drift.unrequested_in_diff);
}

/**
 * Drops a recorded grade because this run states a different intent.
 *
 * The author changed what the change is FOR, so the previous verdict answers a
 * different question, and carrying it would be evidence saying something untrue
 * about what was measured. The rule that keeps an unmeasured run from erasing a
 * grade protects a measurement of the SAME question; this is not that. The row
 * is left holding the new intent and no grade, and the caller scores S7 at zero.
 */
export function supersedeDrift(db: Database, checkId: string, intent: string | null): void {
  db.run(
    'UPDATE checks SET drift = NULL, drift_intent = ?, updated_at = ? WHERE id = ?',
    intent,
    Math.floor(Date.now() / 1000),
    checkId,
  );
  db.run('DELETE FROM drift_items WHERE check_id = ?', checkId);
}

export interface DriftItemRow {
  check_id: string;
  kind: string;
  position: number;
  item: string;
}

export function driftItemsFor(db: Database, checkId: string): DriftItemRow[] {
  return db.all<DriftItemRow>('SELECT * FROM drift_items WHERE check_id = ? ORDER BY kind, position', checkId);
}

export interface PrRow {
  repo_id: string;
  number: number;
  /** The check whose assessment the sticky comment carries. Null on a row
   *  written before eyes-on recorded it. */
  check_id: string | null;
  url: string | null;
  head_sha: string | null;
  state: string | null;
  merge_sha: string | null;
  commented_at: number | null;
  observed_at: number | null;
}

export function findPr(db: Database, repoId: string, number: number): PrRow | undefined {
  return db.get<PrRow>('SELECT * FROM prs WHERE repo_id = ? AND number = ?', repoId, number);
}

/**
 * Notes that the sticky comment for this pull request exists. Stage 3's ledger
 * reads the same row to find the comment it must not duplicate.
 *
 * The check it published is recorded beside it rather than re-derived: a check
 * is keyed on (repository, base, head) and this row holds no base, so a head
 * alone does not name the assessment the comment carries.
 */
export function recordComment(
  db: Database,
  options: { repoId: string; number: number; url: string | null; headSHA: string; checkId: string },
): void {
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO prs (repo_id, number, check_id, url, head_sha, state, merge_sha, commented_at, observed_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT(repo_id, number) DO UPDATE SET
       check_id = excluded.check_id,
       url = COALESCE(excluded.url, prs.url),
       head_sha = excluded.head_sha,
       commented_at = excluded.commented_at,
       observed_at = excluded.observed_at`,
    options.repoId,
    options.number,
    options.checkId,
    options.url,
    options.headSHA,
    now,
    now,
  );
}
