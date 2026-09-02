import type { Context } from './context.js';
import { assertMayMutate } from './context.js';
import { flagBool, flagString } from './args.js';
import { emitDoc, progress, EXIT_OK, EXIT_ERROR, EXIT_USAGE, UserFacingError } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { checkByID, checkID, type CheckRow } from '../db/checks.js';
import { driftItemsFor, latestDecision, recordComment, spotsFor } from '../db/gate.js';
import { findMarked, renderComment, MARKER_PREFIX } from '../gh/comment.js';
import { createComment, listComments, pullHeadSHA, repoSlug, updateComment, GhError } from '../gh/gh.js';
import { maxScore } from '../risk/signals.js';

/**
 * `eyes-on comment --pr <n>` - one sticky comment, and nothing else.
 *
 * Two properties are the acceptance condition for this command and both are
 * enforced somewhere other than here, which is the point:
 *
 *   - **the pull request body is byte-for-byte unchanged.** Not because this
 *     command is careful, but because `src/gh/gh.ts` refuses to spawn any `gh`
 *     invocation outside an allow-list of two comment endpoints. There is no
 *     code path from here to the body.
 *   - **there is exactly one eyes-on comment however many times this runs.**
 *     The marker is searched for first; a match is updated in place and only
 *     its absence creates one.
 *
 * The comment is assembled from what was recorded, never recomputed. A comment
 * that ran its own assessment could disagree with the one `check` printed a
 * minute earlier, and the pull request is the copy people argue with.
 */
export async function commentCommand(context: Context): Promise<number> {
  assertMayMutate(context, 'comment');

  const number = parsePr(flagString(context.args, 'pr'));
  const dryRun = flagBool(context.args, 'dry-run');

  const risk = riskContext(context);
  const db = risk.db;
  if (!db) throw new UserFacingError('no eyes-on state database is open', ['Run `eyes-on init` in this repository first']);

  const id = flagString(context.args, 'check-id') ?? checkID(risk.repoId, risk.baseSHA, risk.headSHA);
  const check = checkByID(db, id);
  if (!check) {
    throw new UserFacingError(`there is no eyes-on assessment to publish for ${risk.headSHA.slice(0, 12)}`, [
      'Run `eyes-on check` on this change first, then `eyes-on spotlight` for the fragments to read',
      'The comment is assembled from what was recorded, so that it cannot disagree with what `check` printed',
    ]);
  }

  const decision = latestDecision(db, id);
  const spots = spotsFor(db, id);

  // GitHub is consulted before the comment is rendered, because whether the
  // pull request has moved on to another commit is part of what the comment
  // says. Rendering first and patching afterwards would be two renderings that
  // can disagree.
  const slug = resolveSlug(risk.clonePath);
  let prHead: string | null = null;
  let existingId: number | null = null;
  let existingUrl: string | null = null;
  let comments = 0;

  if (slug !== null) {
    prHead = pullHeadSHA(risk.clonePath, slug, number);
    const all = listComments(risk.clonePath, slug, number);
    comments = all.length;
    const marked = findMarked(all);
    existingId = marked?.id ?? null;
    existingUrl = marked?.html_url ?? null;
  }

  // A short sha from the API and a full one from the database describe the
  // same commit; comparing them for equality would report every pull request
  // as stale.
  const stale = prHead !== null && !check.head_sha.startsWith(prHead) && !prHead.startsWith(check.head_sha);

  const finalBody = renderComment({
    check,
    scoreMax: maxScore(risk.trusted.config),
    spots,
    hits: hitsFor(db, id),
    decision,
    driftItems: driftItemsFor(db, id),
    signals: db.all<{ name: string; normalized: number }>(
      'SELECT name, normalized FROM signals WHERE check_id = ? ORDER BY normalized DESC',
      id,
    ),
    stale,
    prHeadSHA: prHead,
  });

  const action = existingId === null ? 'create' : 'update';
  let url = existingUrl;

  if (dryRun) {
    progress(context.writers, `dry run: would ${action} the eyes-on comment on #${number}`);
  } else if (slug === null) {
    throw new UserFacingError('gh could not tell eyes-on which GitHub repository this clone belongs to', [
      'Run `gh auth login`, or `gh repo view` in this clone to see what gh reports',
      'Use `eyes-on comment --pr <n> --dry-run` to see the comment eyes-on would publish',
    ]);
  } else {
    const written = existingId === null
      ? createComment(risk.clonePath, slug, number, finalBody)
      : updateComment(risk.clonePath, slug, existingId, finalBody);
    url = written?.html_url ?? existingUrl;
    recordComment(db, { repoId: risk.repoId, number, url, headSHA: check.head_sha });
    progress(context.writers, `${action === 'create' ? 'posted' : 'updated'} the eyes-on comment on #${number}`);
  }

  const doc: ToonObject = {
    pr: number,
    repo: slug,
    action: dryRun ? `would ${action}` : `${action}d`,
    dry_run: dryRun,
    comment_id: existingId,
    comment_url: url,
    marker: MARKER_PREFIX.trim(),
    // How many eyes-on comments were on the pull request *before* this run.
    // Zero on the first publish and one on every later one; two would be the
    // defect this field exists to make visible.
    eyes_on_comments_found: existingId === null ? 0 : 1,
    comments_on_pr: comments,
    check_id: check.id,
    head: check.head_sha.slice(0, 12),
    pr_head: prHead ? prHead.slice(0, 12) : null,
    stale,
    score: check.score,
    band: check.band,
    gate: check.status === 'must_read' && !decision ? 'must_read' : 'none',
    decision: decision?.action ?? null,
    fragments: spots.length,
    drift: check.drift,
    body: finalBody,
    exit_code: EXIT_OK,
    help: helpLines(dryRun, stale, spots.length, check) as ToonValue,
  };

  emitDoc(context.writers, context.format, doc, () => `${finalBody}\n`);
  return EXIT_OK;
}

function helpLines(dryRun: boolean, stale: boolean, fragments: number, check: CheckRow): string[] {
  const lines: string[] = [];
  if (dryRun) lines.push('Nothing was published: --dry-run prints the comment and calls no writing endpoint');
  if (fragments === 0) lines.push('The comment has no fragments to read: run `eyes-on spotlight` and publish again');
  if (stale) {
    lines.push(
      'The pull request head is not the commit this assessment describes; the comment says so. Run `eyes-on check --head <pr head>` and publish again',
    );
  }
  if (check.status === 'must_read') {
    lines.push('The gate is still parked: answer with `eyes-on axi respond --action read` or `--action waive --reason "..."` and publish again');
  }
  lines.push('eyes-on writes exactly one comment per pull request, found by its marker, and never touches the body');
  lines.push('By default this publishes the check for the current base..head; pass --check-id <id> to publish another one');
  return lines;
}

/** The hard-rule hits recorded for a check, one row per glob with its files as
 *  a real list rather than a joined cell. */
function hitsFor(db: NonNullable<ReturnType<typeof riskContext>['db']>, id: string): { glob: string; why: string; files: string[] }[] {
  const rows = db.all<{ glob: string; file: string; why: string }>(
    'SELECT glob, file, why FROM hits WHERE check_id = ? ORDER BY glob, file',
    id,
  );
  const byGlob = new Map<string, { glob: string; why: string; files: string[] }>();
  for (const row of rows) {
    const existing = byGlob.get(row.glob);
    if (existing) existing.files.push(row.file);
    else byGlob.set(row.glob, { glob: row.glob, why: row.why, files: [row.file] });
  }
  return [...byGlob.values()];
}

function parsePr(raw: string | null): number {
  const number = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new UserFacingError(
      raw === null ? 'comment needs --pr <n>' : `--pr ${raw} is not a pull request number`,
      ['Pass the pull request number, for example `eyes-on comment --pr 42`'],
      EXIT_USAGE,
    );
  }
  return number;
}

/** The repository slug, or null when gh cannot say - which `--dry-run` tolerates
 *  and a real publish does not. */
function resolveSlug(clonePath: string): string | null {
  try {
    return repoSlug(clonePath);
  } catch (error) {
    if (error instanceof GhError && error.spawnFailed) {
      throw new UserFacingError('gh is not on PATH, and eyes-on publishes its comment through gh', [
        'Install the GitHub CLI and run `gh auth login`',
        'Use `eyes-on comment --pr <n> --dry-run` to see the comment without publishing it',
      ], EXIT_ERROR);
    }
    throw error;
  }
}
