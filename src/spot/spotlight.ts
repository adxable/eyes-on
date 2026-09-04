import { askModel, extractJson, resolveModelCommand, type ModelOptions, type ModelOutcome } from './agent.js';
import { CATEGORIES, spotlightPrompt } from './prompt.js';
import type { Candidate } from './rank.js';

/**
 * The two stages, joined.
 *
 * Stage one is arithmetic over git (`rank.ts`) and always runs. Stage two is a
 * single model call that picks three to five of its twelve candidates and says
 * why. The report makes the split mandatory rather than an optimisation: the
 * median commit in the reference repository is 604 lines, and a model handed
 * all of it does not read all of it.
 *
 * Everything the model returns is checked against the candidate list before it
 * is believed. A fragment naming a file that is not in the change, a line the
 * ranking never proposed, or a category outside the taxonomy is dropped and
 * counted - not repaired into something plausible. The count is reported, so a
 * model that is drifting shows up as a number rather than as quietly worse
 * answers.
 *
 * When stage two produces fewer than three usable fragments, the shortfall is
 * filled from the top of stage one and each fragment says which stage chose it.
 * A spotlight that returned one fragment because a model was having a bad
 * minute would be read as "there is only one thing here".
 */

export interface Spot {
  file: string;
  line: number;
  /** The taxonomy category, or null when stage one chose this fragment: the
   *  arithmetic knows a fragment is worth reading, not what kind of thing it
   *  is, and guessing would be the one place this product invents a fact. */
  category: string | null;
  why: string;
  weight: number;
  source: 'model' | 'rank';
}

export interface SpotlightResult {
  spots: Spot[];
  /** 1 when no model contributed, 2 when at least one fragment came from it. */
  stage: 1 | 2;
  model: ModelOutcome;
  /** Fragments the model returned that did not survive validation. */
  rejected: number;
  /** Why each rejected fragment was rejected, deduplicated. */
  rejected_reasons: string[];
}

export interface SpotlightOptions {
  candidates: readonly Candidate[];
  n: number;
  intent: string | null;
  score: number;
  band: string;
  /** null when the caller asked for `--no-model`. */
  model: ModelOptions | null;
}

export const MIN_SPOTS = 3;

export function selectSpotlight(options: SpotlightOptions): SpotlightResult {
  const stageOne = fromRanking(options.candidates, options.n);

  if (options.model === null) {
    return {
      spots: stageOne,
      stage: 1,
      model: { state: 'skipped', detail: '--no-model: the second stage was not run and no model was called' },
      rejected: 0,
      rejected_reasons: [],
    };
  }
  if (options.candidates.length === 0) {
    return {
      spots: [],
      stage: 1,
      model: { state: 'skipped', detail: 'the change has no fragments to rank, so there was nothing to ask about' },
      rejected: 0,
      rejected_reasons: [],
    };
  }

  const resolved = resolveModelCommand(options.model);
  if ('refusal' in resolved) {
    return { spots: stageOne, stage: 1, model: resolved.refusal, rejected: 0, rejected_reasons: [] };
  }

  const outcome = askModel(spotlightPrompt(options), options.model);
  if (outcome.state !== 'ok') {
    return { spots: stageOne, stage: 1, model: outcome, rejected: 0, rejected_reasons: [] };
  }

  const parsed = validate(outcome.text, options.candidates, options.n);
  if (parsed.spots.length === 0) {
    return {
      spots: stageOne,
      stage: 1,
      model: {
        state: 'failed',
        command: outcome.command,
        elapsed_ms: outcome.elapsed_ms,
        detail:
          parsed.reasons[0] ??
          'the model returned no fragment that names a candidate of this change; the ranking below is stage one',
      },
      rejected: parsed.rejected,
      rejected_reasons: parsed.reasons,
    };
  }

  return {
    spots: fill(parsed.spots, options.candidates),
    stage: 2,
    model: outcome,
    rejected: parsed.rejected,
    rejected_reasons: parsed.reasons,
  };
}

/** Stage one on its own: the highest-weight fragments, described by the terms
 *  that put them there. */
export function fromRanking(candidates: readonly Candidate[], n: number): Spot[] {
  return candidates.slice(0, clampN(n)).map((candidate) => ({
    file: candidate.file,
    line: candidate.line,
    category: null,
    why: rankingSentence(candidate),
    weight: candidate.weight,
    source: 'rank' as const,
  }));
}

/** The report's range is three to five; anything else asked for is brought
 *  into it rather than refused, because `--n` is a preference and not a
 *  contract. */
export function clampN(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.min(5, Math.max(MIN_SPOTS, Math.floor(n)));
}

export function rankingSentence(candidate: Candidate): string {
  const parts = [`${candidate.size} changed lines in a file the history scores ${candidate.file_risk}/100`];
  if (candidate.hard_rule) parts.push('a hard rule protects this path');
  if (candidate.previously_blamed) parts.push('a past fix blamed the commit that wrote the lines it changes');
  if (candidate.no_test) parts.push('no test changed alongside it');
  if (candidate.created) parts.push('the file is new');
  if (candidate.deleted) parts.push('the file is deleted');
  return `${parts.join('; ')}.`;
}

interface Validated {
  spots: Spot[];
  rejected: number;
  reasons: string[];
}

/**
 * Turns a model answer into fragments, or into nothing.
 *
 * A fragment is kept only when it names a candidate: the same file, and a line
 * inside a hunk the ranking actually proposed for that file. Matching by file
 * alone was tried and rejected in review of this design - a model that answers
 * with the file and line 1 would then be indistinguishable from one that read
 * the fragment.
 */
export function validate(text: string, candidates: readonly Candidate[], n: number): Validated {
  const parsed = extractJson(text);
  if (parsed === null || typeof parsed !== 'object') {
    return { spots: [], rejected: 0, reasons: ['the model answered with something that is not a JSON object'] };
  }
  const list = (parsed as { spotlight?: unknown }).spotlight;
  if (!Array.isArray(list)) {
    return { spots: [], rejected: 0, reasons: ['the model answer has no `spotlight` array'] };
  }

  const byFile = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const existing = byFile.get(candidate.file);
    if (existing) existing.push(candidate);
    else byFile.set(candidate.file, [candidate]);
  }

  const spots: Spot[] = [];
  const reasons: string[] = [];
  const seen = new Set<string>();
  let rejected = 0;

  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') {
      rejected += 1;
      note(reasons, 'an entry was not an object');
      continue;
    }
    const item = entry as Record<string, unknown>;
    const file = typeof item.file === 'string' ? item.file : '';
    const forFile = byFile.get(file);
    if (!forFile) {
      rejected += 1;
      note(reasons, `the model named ${file || '(no file)'}, which is not a candidate fragment of this change`);
      continue;
    }
    const line = typeof item.line === 'number' && Number.isFinite(item.line) ? Math.floor(item.line) : -1;
    const candidate = nearest(forFile, line);
    if (!candidate) {
      rejected += 1;
      note(reasons, `the model named ${file}:${line}, which is not inside any candidate fragment`);
      continue;
    }
    const why = typeof item.why === 'string' ? item.why.trim().replace(/\s+/g, ' ') : '';
    if (why.length === 0) {
      rejected += 1;
      note(reasons, `the model gave no sentence for ${file}:${candidate.line}`);
      continue;
    }
    const key = `${candidate.file}:${candidate.line}`;
    if (seen.has(key)) {
      rejected += 1;
      note(reasons, `the model returned ${key} twice`);
      continue;
    }
    seen.add(key);
    const category = typeof item.category === 'string' ? item.category.trim().toLowerCase() : '';
    spots.push({
      file: candidate.file,
      line: candidate.line,
      // An unknown category is reported as unknown rather than mapped onto the
      // nearest one: the category is what tells a reviewer why they are being
      // sent, and a guessed one is worse than none.
      category: CATEGORIES.includes(category) ? category : null,
      why: why.length > 240 ? `${why.slice(0, 237)}...` : why,
      weight: candidate.weight,
      source: 'model',
    });
    if (spots.length >= clampN(n)) break;
  }
  return { spots, rejected, reasons };
}

/** The candidate whose hunk contains the line, else the closest one in the
 *  same file: a model that reports the line of the change rather than the line
 *  of the hunk header has still identified the fragment. */
function nearest(candidates: readonly Candidate[], line: number): Candidate | null {
  if (candidates.length === 0) return null;
  if (line < 0) return null;
  let best: Candidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.line - line);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // Beyond the size of the hunk the model is no longer pointing at a fragment
  // this ranking proposed, whatever it meant to point at.
  return best !== null && bestDistance <= Math.max(10, best.size) ? best : null;
}

function note(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/** Brings a short answer up to three fragments from the top of stage one. */
function fill(spots: Spot[], candidates: readonly Candidate[]): Spot[] {
  if (spots.length >= MIN_SPOTS) return spots;
  const chosen = new Set(spots.map((spot) => `${spot.file}:${spot.line}`));
  const filled = [...spots];
  for (const candidate of candidates) {
    if (filled.length >= MIN_SPOTS) break;
    const key = `${candidate.file}:${candidate.line}`;
    if (chosen.has(key)) continue;
    chosen.add(key);
    filled.push({
      file: candidate.file,
      line: candidate.line,
      category: null,
      why: rankingSentence(candidate),
      weight: candidate.weight,
      source: 'rank',
    });
  }
  return filled;
}
