import { spawnSync } from 'node:child_process';
import {
  MAX_OUTPUT_BYTES,
  spawnFailureHelp,
  spawnFailureKindOf,
  spawnFailureMessage,
  type SpawnFailureKind,
} from '../core/spawn.js';

/**
 * Every `gh` invocation eyes-on makes goes through here, and the reason is the
 * product's third hard prohibition: eyes-on never edits a pull request body,
 * never merges, and never files a GitHub review. The body belongs to
 * no-mistakes, which regenerates it on every update; a second writer would
 * either lose eyes-on's paragraph on the next push or overwrite no-mistakes'.
 *
 * The enforcement is structural rather than careful. `gh()` is module-private,
 * so no caller outside this file chooses an argument vector, and every
 * invocation is checked by `assertAllowed` before a process is spawned. The
 * allow-list is written as **shapes of whole command lines**, not as a list of
 * forbidden verbs: a deny-list would have to keep up with every endpoint GitHub
 * adds, and the first one it missed would be a silent breach of the prohibition
 * that the product exists to be trusted about.
 *
 * Exactly three things may be written, all of them issue comments:
 *
 *   - `POST   repos/<owner>/<repo>/issues/<n>/comments`
 *   - `PATCH  repos/<owner>/<repo>/issues/comments/<id>`
 *   - nothing else, ever.
 *
 * Note what is *not* in that list and looks as if it might be: `PATCH
 * repos/<owner>/<repo>/issues/<n>` is the endpoint that edits a pull request's
 * body, and it differs from the permitted update by one path segment. That is
 * why the paths are matched whole.
 */

const OWNER = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?`;
const REPO = String.raw`[A-Za-z0-9._-]+`;

/** Reads. Each is anchored, so no query string or extra segment slips past. */
const READ_PATHS: readonly RegExp[] = [
  new RegExp(`^repos/${OWNER}/${REPO}/issues/\\d+/comments(?:\\?[^\\s]*)?$`),
  new RegExp(`^repos/${OWNER}/${REPO}/pulls/\\d+$`),
];

/** The only two writes. */
const WRITE_PATHS: Readonly<Record<string, readonly RegExp[]>> = {
  POST: [new RegExp(`^repos/${OWNER}/${REPO}/issues/\\d+/comments$`)],
  PATCH: [new RegExp(`^repos/${OWNER}/${REPO}/issues/comments/\\d+$`)],
};

export class GhError extends Error {
  readonly status: number;
  readonly stderr: string;
  /** Why gh never produced a status, or null when it ran. Only `missing` is a
   *  host without the GitHub CLI; a listing too large to buffer and a call that
   *  timed out are states of a machine where gh is installed and working. */
  readonly spawnFailure: SpawnFailureKind | null;
  /** The remedies that work in the state this error describes. */
  readonly help: string[];
  constructor(message: string, status: number, stderr: string, spawnFailure: SpawnFailureKind | null = null) {
    super(spawnFailure === null ? message : spawnFailureMessage('gh', spawnFailure, stderr.trim()));
    this.name = 'GhError';
    this.status = status;
    this.stderr = stderr;
    this.spawnFailure = spawnFailure;
    this.help = spawnFailure === null ? [] : spawnFailureHelp('gh', spawnFailure, ghRemedy(spawnFailure));
  }
}

/**
 * What a caller can actually do about a gh spawn failure.
 *
 * A call that timed out has one: try it again once gh can reach GitHub. A
 * listing too large to buffer has none eyes-on can offer - the pull request is
 * as big as it is and no flag here makes it smaller - so the help says only
 * what it can prove, which is that nothing is missing.
 */
function ghRemedy(kind: SpawnFailureKind): string | null {
  return kind === 'timeout' ? 'Check `gh auth status` and that GitHub is reachable, then run the command again' : null;
}

export interface GhResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Refuses any invocation outside the allow-list, before a process exists.
 *
 * Exported so `test/coexistence.test.ts` can assert the prohibition directly
 * against the same function the code runs, rather than against a description of
 * it in a comment.
 */
export function assertAllowed(args: readonly string[]): void {
  const refusal = refusalFor(args);
  if (refusal !== null) {
    throw new GhError(
      `refusing to run "gh ${args.join(' ')}": eyes-on only reads a pull request and writes its own comment (${refusal})`,
      -1,
      '',
    );
  }
}

/** The reason an invocation is refused, or null when it is allowed. */
export function refusalFor(args: readonly string[]): string | null {
  const verb = args[0];
  // `gh repo view` reads; it has no writing form.
  if (verb === 'repo' && args[1] === 'view') return null;
  if (verb !== 'api') {
    return `only \`gh api\` and \`gh repo view\` are permitted; ${verb ?? '(nothing)'} is not`;
  }

  const method = methodOf(args);
  const path = pathOf(args);
  if (path === null) return 'no endpoint path was given';

  if (method === 'GET') {
    return READ_PATHS.some((pattern) => pattern.test(path))
      ? null
      : `${path} is not one of the endpoints eyes-on reads`;
  }
  const allowed = Object.hasOwn(WRITE_PATHS, method) ? WRITE_PATHS[method] : undefined;
  if (!allowed) {
    return `${method} is not a method eyes-on uses; the only writes are POST and PATCH on an issue comment`;
  }
  if (!allowed.some((pattern) => pattern.test(path))) {
    // The message names the one mistake that would actually matter, because a
    // path that is nearly right is the way this prohibition would be broken.
    return `${method} ${path} is not a comment endpoint; eyes-on never edits a pull request body, merges, or files a review`;
  }
  return null;
}

function methodOf(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--method' || arg === '-X') return (args[index + 1] ?? '').toUpperCase();
    if (arg.startsWith('--method=')) return arg.slice('--method='.length).toUpperCase();
  }
  return 'GET';
}

/** The first bare operand after `api`: the endpoint. */
function pathOf(args: readonly string[]): string | null {
  const valued = new Set(['--method', '-X', '-f', '-F', '-H', '--field', '--raw-field', '--header', '--input', '--jq', '-q', '--template', '-t', '--cache']);
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (valued.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return arg;
  }
  return null;
}

function gh(args: readonly string[], options: { cwd?: string; input?: string; timeoutMs?: number } = {}): GhResult {
  assertAllowed(args);
  const result = spawnSync('gh', [...args], {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    // `gh api --paginate` concatenates a page of comments per request, so this
    // grows with the pull request and crosses Node's 1 MiB default on a busy
    // one. Without this a large pull request fails as "gh could not be
    // executed" - which it was.
    maxBuffer: MAX_OUTPUT_BYTES,
    env: { ...process.env, GH_PAGER: 'cat', GH_PROMPT_DISABLED: '1', CLICOLOR: '0' },
  });
  if (result.error) {
    throw new GhError('', -1, String(result.error.message), spawnFailureKindOf(result.error));
  }
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export interface IssueComment {
  id: number;
  body: string;
  /** The comment's own URL, so the command can say where it wrote. */
  html_url: string | null;
  user: string | null;
}

/** `<owner>/<repo>` for the clone, as GitHub knows it. */
export function repoSlug(clonePath: string): string | null {
  const result = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: clonePath });
  if (result.status !== 0) return null;
  const slug = result.stdout.trim();
  return /^[^/\s]+\/[^/\s]+$/.test(slug) ? slug : null;
}

/** Head commit of a pull request, so the comment can name the commit it
 *  describes and a stale comment is recognisable as stale. */
export function pullHeadSHA(clonePath: string, slug: string, number: number): string | null {
  const result = gh(['api', `repos/${slug}/pulls/${number}`, '--jq', '.head.sha'], { cwd: clonePath });
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

export function listComments(clonePath: string, slug: string, number: number): IssueComment[] {
  const result = gh(['api', '--paginate', `repos/${slug}/issues/${number}/comments`], { cwd: clonePath });
  if (result.status !== 0) {
    throw new GhError(`gh could not read the comments of ${slug}#${number}`, result.status, result.stderr);
  }
  return parseComments(result.stdout);
}

/**
 * Parses one or more JSON arrays.
 *
 * `gh api --paginate` concatenates a JSON array per page rather than merging
 * them, so a pull request with more than thirty comments arrives as `[...][...]`
 * - which is not a JSON document. Splitting on the boundary is what makes the
 * sticky-comment search work on a busy pull request rather than on a quiet one.
 */
export function parseComments(text: string): IssueComment[] {
  const comments: IssueComment[] = [];
  for (const chunk of splitJsonArrays(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue;
      const map = entry as Record<string, unknown>;
      if (typeof map.id !== 'number') continue;
      comments.push({
        id: map.id,
        body: typeof map.body === 'string' ? map.body : '',
        html_url: typeof map.html_url === 'string' ? map.html_url : null,
        user:
          map.user !== null && typeof map.user === 'object' && typeof (map.user as Record<string, unknown>).login === 'string'
            ? ((map.user as Record<string, unknown>).login as string)
            : null,
      });
    }
  }
  return comments;
}

function splitJsonArrays(text: string): string[] {
  const chunks: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[' || char === '{') {
      if (depth === 0 && char === '[') start = index;
      depth += 1;
    } else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0 && char === ']') {
        chunks.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return chunks;
}

export function createComment(clonePath: string, slug: string, number: number, body: string): IssueComment | null {
  const result = gh(['api', '--method', 'POST', `repos/${slug}/issues/${number}/comments`, '--input', '-'], {
    cwd: clonePath,
    input: JSON.stringify({ body }),
  });
  if (result.status !== 0) {
    throw new GhError(`gh could not comment on ${slug}#${number}`, result.status, result.stderr);
  }
  return parseComments(`[${result.stdout}]`)[0] ?? null;
}

export function updateComment(clonePath: string, slug: string, id: number, body: string): IssueComment | null {
  const result = gh(['api', '--method', 'PATCH', `repos/${slug}/issues/comments/${id}`, '--input', '-'], {
    cwd: clonePath,
    input: JSON.stringify({ body }),
  });
  if (result.status !== 0) {
    throw new GhError(`gh could not update comment ${id} on ${slug}`, result.status, result.stderr);
  }
  return parseComments(`[${result.stdout}]`)[0] ?? null;
}
