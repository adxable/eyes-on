import { spawnSync } from 'node:child_process';
import {
  MAX_OUTPUT_BYTES,
  signalDetail,
  spawnFailureHelp,
  spawnFailureMessage,
  spawnFailureOf,
  type SpawnFailureKind,
} from '../core/spawn.js';

/**
 * Every `gh` invocation eyes-on makes goes through here, and the reason is the
 * product's third hard prohibition: eyes-on never edits a pull request body,
 * never merges, and never files a GitHub review. The body belongs to
 * no-mistakes, which regenerates it on every update; a second writer would
 * either lose eyes-on's paragraph on the next push or overwrite no-mistakes'.
 *
 * The enforcement is structural rather than careful, and the structure is that
 * **no caller anywhere writes an argument vector**. A caller names one of six
 * operations (`GhOperation`); this module holds the six vectors literally, and
 * `gh()` - which is module-private - is the only thing that builds one. Four of
 * them read and two write, both issue comments:
 *
 *   - `POST   repos/<owner>/<repo>/issues/<n>/comments`
 *   - `PATCH  repos/<owner>/<repo>/issues/comments/<id>`
 *   - nothing else, ever.
 *
 * Note what is absent and looks as if it might belong: `PATCH
 * repos/<owner>/<repo>/issues/<n>` is the endpoint that edits a pull request's
 * body, and it differs from the permitted comment update by one path segment.
 * There is no operation for it, so no vector for it can be built.
 *
 * This shape replaced a parser, and the reason is worth keeping. The parser had
 * to decide read from write by reproducing `gh api`'s own argument semantics,
 * and three review rounds found three ways that reproduction diverged from gh:
 * the attached shorthand `-XPATCH` read as a GET, and then the implicit method,
 * where a vector carrying `--input` and no `--method` is sent as a POST. Each
 * fix was correct and the next round found another. A defence that must model
 * another program's parser is only as good as the model; a defence that emits
 * six fixed vectors has nothing to model.
 *
 * `doctor`'s credential probe is here rather than in `doctor` so that "every gh
 * invocation eyes-on makes comes from this table" has no exception: a rule with
 * one is enforced by memory rather than by shape.
 */

const OWNER = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?`;
const REPO = String.raw`[A-Za-z0-9._-]+`;

const SLUG_PATTERN = new RegExp(`^${OWNER}/${REPO}$`);
const PULL_PATH = new RegExp(`^repos/${OWNER}/${REPO}/pulls/\\d+$`);
const COMMENTS_PATH = new RegExp(`^repos/${OWNER}/${REPO}/issues/\\d+/comments$`);
const COMMENT_PATH = new RegExp(`^repos/${OWNER}/${REPO}/issues/comments/\\d+$`);

/**
 * Everything eyes-on can ask gh to do. There is no seventh.
 *
 * A caller names an operation; this module owns the argument vector. That is
 * the same move `model.agent` makes for the coding agent, and it is here for
 * the same reason it was needed there: narrowing one dimension at a time did
 * not hold. Three review rounds found three ways an argument vector could be
 * read as something other than what gh would do with it - the attached
 * shorthand `-XPATCH` parsed as a GET, then `gh api`'s implicit method, which
 * turns a vector carrying `--input` into a POST with no `--method` in sight.
 *
 * A defence that has to reproduce another program's argument semantics is only
 * ever as good as that reproduction. So the semantics are removed instead: the
 * writing vectors are the two comment endpoints because those are the only
 * vectors that exist, and there is nothing left to infer.
 */
export type GhOperation =
  /** `<owner>/<repo>` for the clone this runs in. */
  | { op: 'repo-slug' }
  /** Whether gh holds a usable credential. */
  | { op: 'auth-status' }
  /** The head commit of a pull request. */
  | { op: 'pull-head'; slug: string; number: number }
  /** Every comment on an issue or pull request. */
  | { op: 'list-comments'; slug: string; number: number }
  /** Post eyes-on's comment. One of the two writes. */
  | { op: 'create-comment'; slug: string; number: number }
  /** Edit the comment eyes-on itself wrote. The other write. */
  | { op: 'update-comment'; slug: string; id: number };

/**
 * A slot in an emitted vector: either the exact token, or the pattern the one
 * interpolated token has to match.
 */
type Slot = string | RegExp;

/**
 * Every argument vector eyes-on can emit, token by token and length included.
 *
 * This is the whole allow-list. Matching is positional and exact - a literal
 * token compares as a string, an interpolated one against an anchored pattern -
 * so no question of "is this token a flag, and what does gh do with it" arises.
 * A vector with an extra token, a missing one, or a token in the wrong place is
 * not one of these and is refused.
 *
 * Note what is absent and looks as if it might be here: `PATCH
 * repos/<owner>/<repo>/issues/<n>` is the endpoint that edits a pull request's
 * body, and it differs from the permitted comment update by one path segment.
 * It has no entry, so it cannot be built.
 */
const EMITTED_VECTORS: readonly (readonly Slot[])[] = [
  ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
  ['auth', 'status'],
  ['api', PULL_PATH, '--jq', '.head.sha'],
  ['api', '--paginate', COMMENTS_PATH],
  ['api', '--method', 'POST', COMMENTS_PATH, '--input', '-'],
  ['api', '--method', 'PATCH', COMMENT_PATH, '--input', '-'],
];

/**
 * The three states a failed `gh` invocation can be in, which are three
 * different things about the machine and want three different sentences.
 *
 * Each has exactly one constructor below and none of them is inferred from a
 * status code. The previous shape read `status < 0` as "refused", and `-1` was
 * also what an invocation with no status at all was given - so a gh killed by
 * the out-of-memory killer arrived as an allow-list refusal, whose help is
 * deliberately empty, and was reported as a defect in eyes-on. A number that
 * means two things cannot be told apart by looking at it harder.
 */
export type GhFailure =
  /** Refused by the allow-list before a process existed. Only eyes-on's own
   *  code builds an argument vector, so reaching this is a defect in eyes-on
   *  and is deliberately left to be reported as one. */
  | 'refused'
  /** gh never produced an exit status; `spawnFailure` says which state that is,
   *  including the one where something outside killed it. */
  | 'spawn'
  /** gh ran, reached GitHub, and the call came back non-zero. A pull request
   *  that does not exist, one the user cannot see, one that is locked - all of
   *  them are answers about the pull request rather than about eyes-on. */
  | 'remote';

/**
 * What to do about a call GitHub refused.
 *
 * Every remote failure eyes-on can produce comes from the one command that
 * talks to GitHub, so the last line names it. None of these ask anyone to
 * report a bug, because gh ran and answered.
 */
const REMOTE_HELP: readonly string[] = [
  'gh ran and GitHub answered, so this is a state of the pull request or of your access to it rather than a defect in eyes-on',
  'Check that the pull request number exists and that you can see it, and run `gh auth status` if it should be visible',
  '`--dry-run` does not get past this: it publishes nothing, but it reads the pull request the same way before rendering the comment',
];

export class GhError extends Error {
  /** gh's exit status, or null when it never produced one. Null rather than a
   *  negative sentinel, so "no status" cannot be mistaken for a status. */
  readonly status: number | null;
  readonly stderr: string;
  /** Why gh never produced a status, or null when it ran. Only `missing` is a
   *  host without the GitHub CLI; a listing too large to buffer, a call that
   *  timed out and a process something else killed are states of a machine
   *  where gh is installed and working. */
  readonly spawnFailure: SpawnFailureKind | null;
  readonly kind: GhFailure;
  /** The remedies that work in the state this error describes, empty when the
   *  honest report is the generic one. The dispatcher renders this rather than
   *  deciding again what kind of failure it is looking at. */
  readonly help: string[];

  private constructor(init: {
    kind: GhFailure;
    message: string;
    status: number | null;
    stderr: string;
    spawnFailure: SpawnFailureKind | null;
    help: readonly string[];
  }) {
    super(init.message);
    this.name = 'GhError';
    this.kind = init.kind;
    this.status = init.status;
    this.stderr = init.stderr;
    this.spawnFailure = init.spawnFailure;
    this.help = [...init.help];
  }

  /** The allow-list said no, before any process existed. */
  static refused(message: string): GhError {
    return new GhError({ kind: 'refused', message, status: null, stderr: '', spawnFailure: null, help: [] });
  }

  /** gh produced no exit status. `detail` is what is known: the runtime's
   *  message, or the signal that killed it. */
  static spawnFailed(kind: SpawnFailureKind, detail: string): GhError {
    return new GhError({
      kind: 'spawn',
      message: spawnFailureMessage('gh', kind, detail),
      status: null,
      stderr: detail,
      spawnFailure: kind,
      help: spawnFailureHelp('gh', kind, ghRemedy(kind)),
    });
  }

  /** gh ran and the call came back non-zero. `what` names the call. */
  static remote(what: string, status: number, stderr: string): GhError {
    const said = firstLine(stderr);
    return new GhError({
      kind: 'remote',
      message: `${what}: gh exited ${status}${said.length > 0 ? ` - ${said}` : ''}`,
      status,
      stderr,
      spawnFailure: null,
      help: REMOTE_HELP,
    });
  }
}

/** What gh said, in one line, so the message carries GitHub's own words. */
function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim().length > 0) ?? '').trim();
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
 * Refuses any invocation that is not one of the vectors `argvFor` emits.
 *
 * Exported so `test/coexistence.test.ts` can assert the prohibition directly
 * against the same function the code runs, rather than against a description of
 * it in a comment. Every vector this module builds passes through here too, so
 * the check is not only a test surface.
 */
export function assertAllowed(args: readonly string[]): void {
  const refusal = refusalFor(args);
  if (refusal !== null) {
    throw GhError.refused(
      `refusing to run "gh ${args.join(' ')}": eyes-on only reads a pull request and writes its own comment (${refusal})`,
    );
  }
}

/** The reason an invocation is refused, or null when it is one eyes-on emits. */
export function refusalFor(args: readonly string[]): string | null {
  for (const vector of EMITTED_VECTORS) {
    if (matches(args, vector)) return null;
  }
  return (
    `"gh ${args.join(' ')}" is not one of the ${EMITTED_VECTORS.length} invocations eyes-on can make; ` +
    'eyes-on never edits a pull request body, merges, or files a review'
  );
}

function matches(args: readonly string[], vector: readonly Slot[]): boolean {
  if (args.length !== vector.length) return false;
  return vector.every((slot, index) => {
    const token = args[index] as string;
    return typeof slot === 'string' ? token === slot : slot.test(token);
  });
}

/**
 * The argument vector for an operation, written literally here.
 *
 * The interpolated parts are checked before they are placed: a slug that is not
 * `<owner>/<repo>` and a number that is not a positive integer are refused
 * rather than pasted into a path. They are the only tokens a caller influences,
 * and `assertAllowed` checks the finished vector again - so a parameter that
 * somehow shaped a different endpoint would still not reach a process.
 */
export function argvFor(operation: GhOperation): string[] {
  switch (operation.op) {
    case 'repo-slug':
      return ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'];
    case 'auth-status':
      return ['auth', 'status'];
    case 'pull-head':
      return ['api', `repos/${slug(operation.slug)}/pulls/${count(operation.number, 'pull request number')}`, '--jq', '.head.sha'];
    case 'list-comments':
      return ['api', '--paginate', `repos/${slug(operation.slug)}/issues/${count(operation.number, 'pull request number')}/comments`];
    case 'create-comment':
      return [
        'api',
        '--method',
        'POST',
        `repos/${slug(operation.slug)}/issues/${count(operation.number, 'pull request number')}/comments`,
        '--input',
        '-',
      ];
    case 'update-comment':
      return [
        'api',
        '--method',
        'PATCH',
        `repos/${slug(operation.slug)}/issues/comments/${count(operation.id, 'comment id')}`,
        '--input',
        '-',
      ];
  }
}

function slug(value: string): string {
  if (!SLUG_PATTERN.test(value)) {
    throw GhError.refused(`refusing to build a gh invocation for "${value}": that is not an <owner>/<repo> eyes-on can address`);
  }
  return value;
}

function count(value: number, what: string): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw GhError.refused(`refusing to build a gh invocation for ${what} ${value}: it is not a positive whole number`);
  }
  return String(value);
}

/**
 * The single door. A caller names an operation and never an argument vector, so
 * this is also the only place a vector exists.
 */
function gh(operation: GhOperation, options: { cwd?: string; input?: string; timeoutMs?: number } = {}): GhResult {
  const args = argvFor(operation);
  assertAllowed(args);
  const result = spawnSync('gh', args, {
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
  // Asked over the whole result: a gh the out-of-memory killer or a Ctrl-C took
  // down sets no error at all, and reading only `result.error` would leave it
  // looking like a success with no status. Past this point `result.status` is a
  // number, so nothing downstream needs a sentinel for the absence of one.
  const failure = spawnFailureOf(result);
  if (failure !== null) {
    throw GhError.spawnFailed(
      failure,
      failure === 'signalled' ? signalDetail(result) : String(result.error?.message ?? ''),
    );
  }
  return { status: result.status as number, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Whether gh holds a usable credential.
 *
 * `doctor`'s readiness probe, and it lives here so that the guarantee above has
 * no exception: it used to spawn gh directly, which meant one invocation in the
 * product reached a process without passing `assertAllowed` and without the
 * output ceiling. An absolute rule is enforceable by shape; one with an
 * exception is enforceable only by memory.
 *
 * Never throws: reporting an unreachable toolchain is what `doctor` is for, and
 * it cannot do that from a stack trace.
 */
export function ghAuthenticated(): boolean {
  try {
    return gh({ op: 'auth-status' }, { timeoutMs: 10_000 }).status === 0;
  } catch (error) {
    if (error instanceof GhError) return false;
    throw error;
  }
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
  const result = gh({ op: 'repo-slug' }, { cwd: clonePath });
  if (result.status !== 0) return null;
  const named = result.stdout.trim();
  // The same shape `argvFor` will accept, checked here so a slug gh reports but
  // eyes-on could not address is "gh named no repository" rather than a refusal
  // thrown from inside the next call.
  return SLUG_PATTERN.test(named) ? named : null;
}

/** Head commit of a pull request, so the comment can name the commit it
 *  describes and a stale comment is recognisable as stale. */
export function pullHeadSHA(clonePath: string, slug: string, number: number): string | null {
  const result = gh({ op: 'pull-head', slug, number }, { cwd: clonePath });
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

export function listComments(clonePath: string, slug: string, number: number): IssueComment[] {
  const result = gh({ op: 'list-comments', slug, number }, { cwd: clonePath });
  if (result.status !== 0) {
    throw GhError.remote(`gh could not read the comments of ${slug}#${number}`, result.status, result.stderr);
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
  const result = gh({ op: 'create-comment', slug, number }, { cwd: clonePath, input: JSON.stringify({ body }) });
  if (result.status !== 0) {
    throw GhError.remote(`gh could not comment on ${slug}#${number}`, result.status, result.stderr);
  }
  return parseComments(`[${result.stdout}]`)[0] ?? null;
}

export function updateComment(clonePath: string, slug: string, id: number, body: string): IssueComment | null {
  const result = gh({ op: 'update-comment', slug, id }, { cwd: clonePath, input: JSON.stringify({ body }) });
  if (result.status !== 0) {
    throw GhError.remote(`gh could not update comment ${id} on ${slug}`, result.status, result.stderr);
  }
  return parseComments(`[${result.stdout}]`)[0] ?? null;
}
