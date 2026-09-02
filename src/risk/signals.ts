import { SIGNAL_NAMES, type RepoConfig, type SignalName } from './repoconfig.js';

/**
 * The seven signals, the saturation curve, the weighted score and the two
 * thresholds. All four are the report's (section 5, Appendix C.3) and none of
 * them is a place to improvise.
 *
 * ## The curve
 *
 * Every signal is normalised by `min(1, ln(1+x) / ln(1+K))`, where K is the
 * value at which that signal is considered saturated. The shape is the point:
 * the first fix a file attracts moves the number a long way, the fifth barely
 * at all. A linear scale would let one enormous file decide every score, and a
 * hard cut-off would make the difference between four fixes and five larger
 * than the difference between one and four.
 *
 * ## The aggregation
 *
 * Three signals are properties of a file (fix history, churn, recency) and the
 * change touches several. They are aggregated by **maximum**, not by mean or
 * sum, and the reason is the question the product answers: "is there something
 * in here a human has to read?" One file with a bad history is a yes, however
 * many quiet files travel with it. A mean would let a wide, dull change dilute
 * exactly the file the reviewer was needed for, and a sum would re-count the
 * breadth that the size and spread signals already carry at their own weights.
 *
 * The per-file values are kept alongside the maximum, because `why` has to name
 * the file that decided the score rather than assert a number.
 *
 * ## What is not counted
 *
 * S1 and S2 are computed over code files only - the report requires it, and the
 * measurement behind the requirement is that without it `AGENTS.md` ranks first
 * on the reference repository. S3 and S4 are computed over code files too. The
 * report does not require that, and it does not forbid it; the argument is the
 * same one, and one consistent file set is what makes `why` explicable ("these
 * are the files this score is about") instead of needing a footnote per signal.
 * The **hard rules** are the deliberate exception: they match the full changed
 * file list, filtered by nothing at all (see `rules/hard.ts`).
 */

/** `min(1, ln(1+x)/ln(1+K))`, the report's normalisation, for x ≥ 0. */
export function saturate(x: number, k: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  if (!Number.isFinite(k) || k <= 0) return 1;
  return Math.min(1, Math.log1p(x) / Math.log1p(k));
}

export interface SignalValue {
  name: SignalName;
  /** The measurement, in the signal's own units. */
  raw: number;
  /** The measurement after the curve, in [0, 1]. */
  normalized: number;
  weight: number;
  /** `weight * normalized`, in [0, 1]: this signal's share of the score. */
  contribution: number;
  /** What the raw number counts, in one clause, for the human rendering. */
  unit: string;
  /** The file the raw number came from, for signals aggregated by maximum. */
  from: string | null;
}

export type Band = 'auto' | 'wskazane' | 'pelna';

/**
 * Band identifiers are the report's, in Polish, and they stay that way while
 * every other string the CLI prints is English.
 *
 * They are not display text: Appendix C.4 pins them into the machine-readable
 * marker of the pull-request comment (`{"band":"wskazane"}`), which stages 2
 * and 3 parse to find their own comment and to write the ledger. Translating
 * them here would silently break that contract. `bandLabel` is what a human
 * reads.
 */
export function bandLabel(band: Band): string {
  switch (band) {
    case 'auto':
      return 'no reading required';
    case 'wskazane':
      return 'read the indicated fragments';
    case 'pelna':
      return 'full review';
  }
}

export function bandFor(score: number, thresholds: RepoConfig['thresholds']): Band {
  if (score >= thresholds.full_review) return 'pelna';
  if (score >= thresholds.read_fragments) return 'wskazane';
  return 'auto';
}

/**
 * Where the drift grade in a score came from.
 *
 * A check is keyed on (repository, base, head), so a grade recorded against a
 * row is a measurement of *this* diff and a later run that measured none keeps
 * it rather than erasing it. That is the right arithmetic and the wrong
 * evidence unless the reader is told: a score carrying a grade this invocation
 * did not take is claiming more than this invocation measured. So the three
 * states are named and distinguished everywhere the score is shown.
 */
export type DriftProvenance =
  /** This invocation ran the two passes and got the grade. */
  | 'measured'
  /** The grade is the one already recorded for this same base..head. Every
   *  command that only reads the row - `status`, `comment` - is always here. */
  | 'carried'
  /** There is no grade at all. */
  | 'none';

/**
 * A grade, where it came from, and the intent it answers.
 *
 * The last of those is not decoration. A drift grade is a measurement of the
 * pair (diff, intent), and the row it lives on is keyed by (repository, base,
 * head) - the intent is outside that key. So a reader has to be able to see
 * that the grade in front of them answers the intent in front of them, and
 * every surface takes the sentence from here rather than writing its own.
 */
export interface DriftEvidence {
  provenance: DriftProvenance;
  grade: number | null;
  /** The intent the grade answers, or the intent this run stated when there is
   *  no grade. */
  intent: string | null;
  /** A grade this run dropped because it stated a different intent: what it
   *  was, and what it answered. */
  superseded?: { grade: number; intent: string | null } | null;
}

/**
 * The one sentence that says where the grade came from and what it answers,
 * written here rather than in each renderer so no surface can claim more than
 * another.
 */
export function driftProvenanceSentence(evidence: DriftEvidence): string {
  const against = (intent: string | null): string =>
    intent === null ? 'an intent nobody recorded' : `the intent "${shortIntent(intent)}"`;

  if (evidence.provenance === 'none' || evidence.grade === null) {
    if (evidence.superseded) {
      return (
        `No drift grade for ${against(evidence.intent)}: the recorded ${evidence.superseded.grade}/5 was measured ` +
        `against ${against(evidence.superseded.intent)} and answers a different question, so S7 is zero.`
      );
    }
    return 'No drift grade: the stated intent was not compared with this diff, so S7 is zero.';
  }
  if (evidence.provenance === 'carried') {
    return (
      `Drift ${evidence.grade}/5 is carried from an earlier measurement of this same change against ` +
      `${against(evidence.intent)} - nothing was measured now - and the score contains it as S7.`
    );
  }
  return `Drift ${evidence.grade}/5 was measured for this change against ${against(evidence.intent)}, and the score contains it as S7.`;
}

/** An intent short enough to sit in one sentence, whole when it already is. */
export function shortIntent(intent: string): string {
  const flat = normalizeIntent(intent);
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}\u2026`;
}

/** Two intents are the same question when they differ only in whitespace. The
 *  comparison is on the whole text, never on the shortened display form: two
 *  intents that agree for eighty characters and diverge after are two
 *  questions. */
export function normalizeIntent(intent: string): string {
  return intent.replace(/\s+/g, ' ').trim();
}

/** The raw measurement of each signal, before weights and the curve. */
export type RawSignals = Record<SignalName, { value: number; from: string | null }>;

export const SIGNAL_UNITS: Record<SignalName, string> = {
  fix_history: 'fix commits that blamed into the file',
  churn: 'commits touching the file in the window',
  size: 'lines added and removed in code files',
  spread: 'directories the change reaches into',
  no_test: 'share of changed code files with no test changed alongside',
  recency: 'days of freshness (30 = touched today, 0 = untouched for a month)',
  drift: 'grades of intent-versus-diff drift above an aligned 1 of 5',
};

export interface Score {
  score: number;
  band: Band;
  signals: SignalValue[];
}

/**
 * The largest score these weights can produce.
 *
 * Not a constant 100. The seven default weights sum to 1.20 once drift is
 * scored (see the note in `repoconfig.ts`), and a repository may set its own
 * weights anyway, so the only honest denominator is the one the weights imply.
 * Every rendering that shows a score out of something reads it from here.
 */
export function maxScore(config: RepoConfig): number {
  return Math.round(SIGNAL_NAMES.reduce((sum, name) => sum + config.weights[name], 0) * 100);
}

/** Applies the weights and the curve. The only place a score is produced. */
export function scoreSignals(raw: RawSignals, config: RepoConfig): Score {
  const signals: SignalValue[] = SIGNAL_NAMES.map((name) => {
    const measured = raw[name];
    const weight = config.weights[name];
    const normalized = saturate(measured.value, config.saturation[name]);
    return {
      name,
      raw: measured.value,
      normalized,
      weight,
      contribution: weight * normalized,
      unit: SIGNAL_UNITS[name],
      from: measured.from,
    };
  });
  const total = signals.reduce((sum, signal) => sum + signal.contribution, 0);
  // Rounded once, here, so the number in the report, the number in the database
  // and the number the band was decided from are the same number.
  const score = Math.round(total * 100);
  return { score, band: bandFor(score, config.thresholds), signals };
}

/**
 * The rationale a human reads: the signals that actually moved the score,
 * largest contribution first, with the file that produced each one.
 *
 * Signals contributing nothing are dropped rather than listed as zeroes -
 * except when nothing contributed at all, where saying so is the answer.
 */
export function rationale(score: Score): string[] {
  const moved = score.signals
    .filter((signal) => signal.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution);
  if (moved.length === 0) {
    return ['no signal moved the score: nothing in this change matches a risk the history knows about'];
  }
  return moved.map((signal) => {
    const points = Math.round(signal.contribution * 100);
    const where = signal.from ? ` (${signal.from})` : '';
    return `${signal.name} ${format(signal.normalized)} x weight ${format(signal.weight)} = ${points} points${where}: ${formatRaw(signal)}`;
  });
}

function formatRaw(signal: SignalValue): string {
  // `no_test` is a share, and "1 share of changed code files" is not a sentence
  // anybody can act on. Every other signal counts whole things.
  if (signal.name === 'no_test') {
    return `${Math.round(signal.raw * 100)}% of changed code files had no test changed alongside them`;
  }
  const value = Number.isInteger(signal.raw) ? String(signal.raw) : signal.raw.toFixed(2);
  return `${value} ${signal.unit}`;
}

function format(value: number): string {
  return value.toFixed(2);
}

/**
 * Which grade a run should score with, and what to record, when it measured
 * one or did not.
 *
 * A drift grade is a measurement of the pair (diff, intent). The row it lives
 * on is keyed by (repository, base, head), so the intent is outside the key and
 * every command that touches the row has to answer the same question: does the
 * grade already recorded here answer the question being asked now? Three cases,
 * and they are decided in one place because four commands read them.
 */
export interface CarryInput {
  /** The grade this invocation measured, or null when it measured none. */
  measured: number | null;
  /** The intent this invocation was given, or null when it was given none. */
  intent: string | null;
  /** The grade on the recorded row, and the intent it was measured against. */
  recordedGrade: number | null;
  recordedIntent: string | null;
  /** The row's own `intent` column, which is not always the grade's: a row
   *  written before eyes-on recorded `drift_intent` has one and not the other,
   *  and a run that states no intent must keep what the row already says rather
   *  than blanking it because the grade named nothing. */
  recordedRowIntent: string | null;
}

export interface CarryDecision extends DriftEvidence {
  /** The intent that belongs on the row after this run. */
  rowIntent: string | null;
  /** True when the recorded drift facts answer a different question and must be
   *  replaced by an entry for the new intent carrying no grade. */
  supersede: boolean;
}

export function carryDrift(input: CarryInput): CarryDecision {
  if (input.measured !== null) {
    return {
      provenance: 'measured',
      grade: input.measured,
      intent: input.intent,
      rowIntent: input.intent,
      supersede: false,
    };
  }

  // This run asked no drift question, so it decides nothing about drift: the
  // recorded grade is still a measurement of this same diff against the intent
  // on the row, and the row keeps that intent rather than being blanked.
  if (input.intent === null) {
    return {
      provenance: input.recordedGrade === null ? 'none' : 'carried',
      grade: input.recordedGrade,
      intent: input.recordedIntent,
      rowIntent: input.recordedRowIntent,
      supersede: false,
    };
  }

  const sameQuestion =
    input.recordedIntent !== null && normalizeIntent(input.recordedIntent) === normalizeIntent(input.intent);
  if (input.recordedGrade !== null && sameQuestion) {
    return {
      provenance: 'carried',
      grade: input.recordedGrade,
      intent: input.recordedIntent,
      rowIntent: input.intent,
      supersede: false,
    };
  }

  return {
    provenance: 'none',
    grade: null,
    intent: input.intent,
    rowIntent: input.intent,
    supersede: input.recordedGrade !== null,
    superseded:
      input.recordedGrade === null ? null : { grade: input.recordedGrade, intent: input.recordedIntent },
  };
}
