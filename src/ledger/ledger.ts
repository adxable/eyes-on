import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Paths } from '../core/paths.js';
import type { LinkAgreement } from './link.js';

/**
 * `ledger.jsonl` - the channel register (report section 5, P5; Appendix C.2).
 *
 * One JSON object per line, **appended and never rewritten**. That is not a
 * storage preference: the register is the evidence stage 3 argues thresholds
 * from, and a file that can be edited in place is a file whose earlier readings
 * cannot be recovered. A pull request labelled twice gets two lines, the newest
 * wins for every reader, and both survive.
 *
 * ## Every field carries what it was recorded against
 *
 * The rule AGENTS.md states for the database applies to every line here, and it
 * is why this record is wide rather than the seven-field sketch in Appendix C.2:
 *
 *   - a **score** means nothing without the maximum the weights it was computed
 *     under could produce, so `score_max` travels with it and `calibrate`
 *     refuses to sweep thresholds across two different ones;
 *   - a **band** set by a hard rule does not move when a threshold moves, so
 *     `band_from` travels with it and the sweep holds those changes at `pelna`;
 *   - a **band** on an `unverified` check is a floor - no hard rule was
 *     evaluated at all - so `unverified` travels with it and a reader of the
 *     channel table is told how many rows may be in the wrong channel;
 *   - a **gate decision** answers a set of hard-rule hits, so the fingerprint it
 *     answered and the configuration those hits came from travel with it, and
 *     `covers_recorded_hits` says whether it answers the hits in this very row;
 *   - a **drift grade** measures the pair (diff, intent), so `drift_intent`
 *     travels with it and is not assumed to be the row's own `intent`;
 *   - the **link** from the change to the commit that landed it was
 *     reconstructed from two sources that can disagree, so both shas and the
 *     agreement between them travel with it rather than one merged answer, and
 *     `git_candidates` says how many default-branch commits carried the `(#N)`
 *     subject the git side chose from.
 */

export const LEDGER_VERSION = 1;

/** How `label` found the assessment this record describes. Recorded because
 *  "which run this row is about" is exactly the sort of thing that cannot be
 *  re-derived later from the row itself. */
export type CheckSource =
  /** `--check-id`, named by the caller. */
  | 'flag'
  /** The check the sticky pull-request comment published, from `prs.check_id`. */
  | 'comment'
  /** A recorded check of the commit GitHub named as the pull request's head. */
  | 'pr-head'
  /** A recorded check of the merge commit itself - the run over the squashed
   *  change, which is what a sweep of history produces. */
  | 'merge-commit';

export interface LedgerDecision {
  action: string;
  reason: string | null;
  decided_by: string | null;
  decided_at: number;
  /** The set of hard-rule hits this answer was given against. */
  hits_fingerprint: string | null;
  /** The trusted configuration those hits came from. */
  config_sha: string | null;
  /** Whether it answers the hits recorded in this row. False is a real state:
   *  an answer given before a rule appeared does not decide that rule. */
  covers_recorded_hits: boolean;
}

export interface LedgerRecord {
  v: number;
  recorded_at: number;

  /** eyes-on's own repository id, and the slug GitHub knows it by. */
  repo: string;
  repo_slug: string | null;
  pr: number;
  pr_url: string | null;
  pr_title: string | null;
  base_branch: string | null;

  /** The commit that landed the change on the base branch, when both sources
   *  agree on one - `link` carries what each said. */
  merge_sha: string | null;
  merge_subject: string | null;
  /** First parent of the merge commit: the commit the change landed on. */
  merge_parent_sha: string | null;
  /** How many parents that commit has. A squash merge has one and introduces
   *  every line of the change; a true merge commit has two and introduces no
   *  line at all, which is what decides whether `leaks` can attribute anything
   *  to it. */
  merge_parents: number | null;
  /** The tip of the proposed branch, as GitHub named it. */
  head_sha: string | null;
  merged_at: number | null;

  link: {
    agreement: LinkAgreement;
    git_merge_sha: string | null;
    github_merge_sha: string | null;
    /** How many default-branch commits carried this pull request's `(#N)`
     *  subject. More than one means `git_merge_sha` is the newest of several
     *  candidates rather than the only one, and `leaks` blames every later fix
     *  against it - so the row says so instead of the choice being invisible. */
    git_candidates: number;
    sentence: string;
  };

  check_id: string;
  check_source: CheckSource;
  check_base_sha: string;
  check_head_sha: string;

  score: number | null;
  /** The largest score the weights this was computed under could produce. */
  score_max: number | null;
  band: string | null;
  /** `hard rule` when a rule forced `pelna`, `score` when the thresholds chose
   *  it. A threshold sweep may only move the second kind. */
  band_from: 'hard rule' | 'score';
  /** True when the trusted configuration could not be read, so no hard rule was
   *  evaluated and the band above is a lower bound. */
  unverified: boolean;

  /** One entry per matched file, never a joined string. */
  hard_rules: { glob: string; file: string }[];
  /** The identity of that set, as the gate names it. */
  hits_fingerprint: string;

  decision: LedgerDecision | null;
  /** Whether the change was still parked when it was labelled. A merged change
   *  nobody answered for is a fact the register exists to be able to state. */
  gate: 'must_read' | 'none';

  drift: number | null;
  /** The intent the grade above was measured against, which is not always the
   *  row's own `intent`. */
  drift_intent: string | null;
  intent: string | null;

  config_sha: string | null;
  eyes_on_version: string;
}

/**
 * Appends one record. The directory is created first, because the ledger may be
 * the first thing written to a state root a `daemon run --root` never touched.
 *
 * A single `appendFileSync` of one line: `O_APPEND` writes of less than a pipe
 * buffer do not interleave, so two `label` runs racing produce two whole lines
 * rather than one torn one.
 */
export function appendRecord(paths: Paths, record: LedgerRecord): void {
  mkdirSync(dirname(paths.ledger), { recursive: true });
  appendFileSync(paths.ledger, `${JSON.stringify(record)}\n`, { mode: 0o644 });
}

export interface LedgerRead {
  records: LedgerRecord[];
  /** Lines that were not a record of a version this build understands. Counted
   *  rather than thrown on: a register is append-only evidence, and one line a
   *  future version wrote must not stop the whole file being read. Every report
   *  says how many it skipped. */
  skipped: number;
  /** True when the file does not exist yet, which is not the same as an empty
   *  one: nobody has run `label`, rather than nothing merged. */
  absent: boolean;
}

export function readLedger(paths: Paths): LedgerRead {
  let text: string;
  try {
    text = readFileSync(paths.ledger, 'utf8');
  } catch {
    return { records: [], skipped: 0, absent: true };
  }
  const records: LedgerRecord[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const record = parseRecord(line);
    if (record === null) skipped += 1;
    else records.push(record);
  }
  return { records, skipped, absent: false };
}

/** One line, or null when it is not a record this build can read. */
export function parseRecord(line: string): LedgerRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const map = parsed as Record<string, unknown>;
  if (map.v !== LEDGER_VERSION) return null;
  if (typeof map.repo !== 'string' || typeof map.pr !== 'number') return null;
  return parsed as LedgerRecord;
}

/**
 * The newest record for each pull request, newest-last order preserved.
 *
 * Re-labelling is an ordinary thing to do - a gate answered after the merge, a
 * check re-run - and the register keeps both lines. Every reader asks for the
 * latest, so no report can be made to disagree with another by choosing a
 * different one.
 */
export function latestPerPull(records: readonly LedgerRecord[]): LedgerRecord[] {
  const newest = new Map<string, LedgerRecord>();
  for (const record of records) {
    const key = `${record.repo}#${record.pr}`;
    const seen = newest.get(key);
    if (!seen || record.recorded_at >= seen.recorded_at) newest.set(key, record);
  }
  return [...newest.values()].sort((a, b) => a.pr - b.pr);
}

/** The records of one repository, newest per pull request. */
export function recordsFor(records: readonly LedgerRecord[], repoId: string): LedgerRecord[] {
  return latestPerPull(records.filter((record) => record.repo === repoId));
}
