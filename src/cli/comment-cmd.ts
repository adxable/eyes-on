import type { Context } from './context.js';
import { assertMayMutate } from './context.js';
import { flagBool, flagString } from './args.js';
import { emitDoc, progress, EXIT_OK, EXIT_ERROR, EXIT_USAGE, UserFacingError } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';
import { riskContext } from './risk-context.js';
import { checkByID, checkID, type CheckRow } from '../db/checks.js';
import { driftItemsFor, recordedDecisionCovering, recordComment, spotsFor } from '../db/gate.js';
import { findAllMarked, renderComment, MARKER_PREFIX } from '../gh/comment.js';
import { createComment, listComments, pullHeadSHA, repoSlug, updateComment, GhError } from '../gh/gh.js';
import { carriedEvidence, driftProvenanceSentence, unverifiedSentence } from '../risk/signals.js';

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

  // The decision that answers the hits recorded for this check, never merely
  // the newest one: publishing a waiver beside a rule it was not given against
  // attributes it to a rule nobody was shown.
  const decision = recordedDecisionCovering(db, id);
  const spots = spotsFor(db, id);

  // GitHub is consulted before the comment is rendered, because whether the
  // pull request has moved on to another commit is part of what the comment
  // says. Rendering first and patching afterwards would be two renderings that
  // can disagree.
  const slug = resolveSlug(risk.clonePath, dryRun);
  // Whether eyes-on got to look at the pull request at all. A dry run on a host
  // without gh, and one where gh cannot name the repository, both reach the end
  // of this command having read nothing from GitHub - so every field describing
  // what is on the pull request has to say "not checked" rather than "none".
  // Zero comments and a comment nobody looked for are different facts.
  const checked = slug !== null;
  let prHead: string | null = null;
  let existingId: number | null = null;
  let existingUrl: string | null = null;
  let comments = 0;
  let markedFound = 0;

  if (slug !== null) {
    prHead = pullHeadSHA(risk.clonePath, slug, number);
    const all = listComments(risk.clonePath, slug, number);
    comments = all.length;
    const marked = findAllMarked(all);
    // Counted rather than derived from the one that will be updated: a second
    // eyes-on comment is the defect this number exists to make visible, and a
    // count that can only be 0 or 1 cannot report it.
    markedFound = marked.length;
    existingId = marked[0]?.id ?? null;
    existingUrl = marked[0]?.html_url ?? null;
  }

  // A short sha from the API and a full one from the database describe the
  // same commit; comparing them for equality would report every pull request
  // as stale.
  const stale = prHead !== null && !check.head_sha.startsWith(prHead) && !prHead.startsWith(check.head_sha);

  const finalBody = renderComment({
    check,
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
  // The comment this run ended up pointing at, which on a create is the one it
  // just made. Reporting `existingId` here would leave the first publish with
  // no id at all, so an agent could not address the comment it just wrote.
  let commentId = existingId;

  if (dryRun) {
    progress(
      context.writers,
      checked
        ? `dry run: would ${action} the eyes-on comment on #${number}`
        : `dry run: eyes-on could not reach #${number} through gh, so whether its comment would be created or updated was never checked`,
    );
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
    commentId = written?.id ?? existingId;
    recordComment(db, { repoId: risk.repoId, number, url, headSHA: check.head_sha, checkId: check.id });
    progress(context.writers, `${action === 'create' ? 'posted' : 'updated'} the eyes-on comment on #${number}`);
  }

  const doc: ToonObject = {
    pr: number,
    repo: slug,
    action: checked ? (dryRun ? `would ${action}` : `${action}d`) : 'would create or update',
    dry_run: dryRun,
    // Whether the pull request was read at all. False makes the three counts
    // below null rather than zero, because a run that never called gh knows
    // nothing about what is on the pull request and must not report a number it
    // did not measure.
    pull_request_checked: checked,
    comment_id: commentId,
    comment_url: url,
    marker: MARKER_PREFIX.trim(),
    // How many eyes-on comments were on the pull request *before* this run.
    // Zero on the first publish and one on every later one; two would be the
    // defect this field exists to make visible.
    eyes_on_comments_found: checked ? markedFound : null,
    comments_on_pr: checked ? comments : null,
    check_id: check.id,
    head: check.head_sha.slice(0, 12),
    pr_head: prHead ? prHead.slice(0, 12) : null,
    stale,
    score: check.score,
    score_max: check.score_max,
    band: check.band,
    gate: check.status === 'must_read' && !decision ? 'must_read' : 'none',
    // The band travels with what was behind it. An unverified check evaluated
    // no hard rule at all, so the channel published above is a floor.
    unverified: check.status === 'unverified',
    decision: decision?.action ?? null,
    fragments: spots.length,
    drift: check.drift,
    // This command measures nothing, so a grade it publishes is always one an
    // earlier run took of this same change. Same three states, same sentence,
    // one source - `check` and `status` report it the same way.
    drift_intent: check.drift_intent,
    drift_provenance: carriedEvidence(check).provenance,
    drift_sentence: driftProvenanceSentence(carriedEvidence(check)),
    body: finalBody,
    exit_code: EXIT_OK,
    help: helpLines(dryRun, stale, spots.length, check, markedFound, checked) as ToonValue,
  };

  emitDoc(context.writers, context.format, doc, () => `${finalBody}\n`);
  return EXIT_OK;
}

function helpLines(
  dryRun: boolean,
  stale: boolean,
  fragments: number,
  check: CheckRow,
  markedFound: number,
  checked: boolean,
): string[] {
  const lines: string[] = [];
  if (dryRun) lines.push('Nothing was published: --dry-run prints the comment and calls no writing endpoint');
  if (!checked) {
    lines.push(
      'gh could not name this repository, so eyes-on never looked at the pull request: whether an eyes-on comment is already there is unknown, and the comment counts are null rather than zero',
    );
    lines.push('Install the GitHub CLI and run `gh auth login` to publish; the comment above is rendered from what was recorded and does not need gh');
  }
  if (fragments === 0) lines.push('The comment has no fragments to read: run `eyes-on spotlight` and publish again');
  if (stale) {
    lines.push(
      'The pull request head is not the commit this assessment describes; the comment says so. Run `eyes-on check --head <pr head>` and publish again',
    );
  }
  if (check.status === 'must_read') {
    lines.push('The gate is still parked: answer with `eyes-on axi respond --action read` or `--action waive --reason "..."` and publish again');
  }
  if (check.status === 'unverified') {
    lines.push(`${unverifiedSentence()} The comment says so; re-run \`eyes-on check\` once the configuration parses and publish again`);
  }
  if (markedFound > 1) {
    lines.push(
      `There are ${markedFound} eyes-on comments on this pull request; the oldest was updated and the rest were left alone. Delete the extras on GitHub - eyes-on never deletes a comment`,
    );
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

/**
 * The repository slug, or null when gh cannot say.
 *
 * A dry run is a preview of a comment assembled entirely from what was
 * recorded, so it needs gh for exactly one thing - looking at the pull request
 * to see whether an eyes-on comment is already there - and that is a fact it
 * can honestly report as unchecked. Refusing the whole command on a host
 * without the GitHub CLI made the publish path's own advice ("use --dry-run")
 * name a command that failed the same way, which is the state-the-code-is-not-in
 * failure this product is built around avoiding. So absence returns null here
 * and the refusal stays on the publish path, where it is true.
 */
function resolveSlug(clonePath: string, dryRun: boolean): string | null {
  try {
    return repoSlug(clonePath);
  } catch (error) {
    // Only absence is answered here. Every other spawn failure - a listing too
    // large to buffer, a call that timed out - already carries its own sentence
    // and help, and re-describing it as "gh is not on PATH" is the failure that
    // classification exists to prevent.
    if (error instanceof GhError && error.spawnFailure === 'missing') {
      if (dryRun) return null;
      throw new UserFacingError('gh is not on PATH, and eyes-on publishes its comment through gh', [
        'Install the GitHub CLI and run `gh auth login`',
        'Use `eyes-on comment --pr <n> --dry-run` to see the comment without publishing it',
      ], EXIT_ERROR);
    }
    throw error;
  }
}
