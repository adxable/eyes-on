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
 *
 * The three reads are `gh repo view`, `gh auth status` and two `gh api`
 * endpoints. `doctor`'s credential probe is here rather than in `doctor` so
 * that "every gh invocation eyes-on makes passes `assertAllowed`" has no
 * exception: a rule with one is enforced by memory rather than by shape.
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
 * Refuses any invocation outside the allow-list, before a process exists.
 *
 * Exported so `test/coexistence.test.ts` can assert the prohibition directly
 * against the same function the code runs, rather than against a description of
 * it in a comment.
 */
export function assertAllowed(args: readonly string[]): void {
  const refusal = refusalFor(args);
  if (refusal !== null) {
    throw GhError.refused(
      `refusing to run "gh ${args.join(' ')}": eyes-on only reads a pull request and writes its own comment (${refusal})`,
    );
  }
}

/**
 * The options eyes-on itself passes to `gh api`, and whether each takes a
 * value. Everything else is refused.
 *
 * This is an allow-list of **spellings**, not only of endpoints, and it is
 * default-deny for the reason the endpoint list is: a parser that has to
 * understand its whole input is only as good as the forms it knows. `methodOf`
 * used to recognise `--method X`, `-X X` and `--method=X` and not pflag's
 * attached shorthand `-XPATCH`, which gh accepts - so `gh api -XPATCH
 * repos/o/r/pulls/7` fell through to GET, matched a read path, and was allowed.
 * That is the one endpoint this product promises it structurally cannot reach.
 *
 * Refusing what cannot be interpreted with certainty is what makes the next
 * spelling nobody anticipated fail closed instead of being read as a GET.
 */
interface FlagSpec {
  /** What the option means, so a shorthand and its long form are one fact. */
  name: string;
  takesValue: boolean;
}

const API_FLAGS: Readonly<Record<string, FlagSpec>> = {
  '--method': { name: 'method', takesValue: true },
  '-X': { name: 'method', takesValue: true },
  '--input': { name: 'input', takesValue: true },
  '--jq': { name: 'jq', takesValue: true },
  '-q': { name: 'jq', takesValue: true },
  '--paginate': { name: 'paginate', takesValue: false },
};

/** The same, for `gh repo view`. It has no writing form, but a vector eyes-on
 *  cannot read is refused there too rather than passed through unexamined. */
const REPO_VIEW_FLAGS: Readonly<Record<string, FlagSpec>> = {
  '--json': { name: 'json', takesValue: true },
  '--jq': { name: 'jq', takesValue: true },
  '-q': { name: 'jq', takesValue: true },
};

interface ParsedArgv {
  /** Option name to the last value given for it. */
  values: Map<string, string>;
  /** Everything that is not an option or an option's value. */
  operands: string[];
}

/**
 * Reads an argument vector, or says why it cannot.
 *
 * Handles every form gh accepts for the options above - `--long value`,
 * `--long=value`, `-s value` and the attached `-svalue` - and refuses anything
 * outside the table, an option given no value, and a value attached to an
 * option that takes none.
 */
function parseArgv(args: readonly string[], table: Readonly<Record<string, FlagSpec>>): ParsedArgv | { refusal: string } {
  const values = new Map<string, string>();
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '-' || !arg.startsWith('-')) {
      operands.push(arg);
      continue;
    }
    let token = arg;
    let attached: string | null = null;
    const equals = arg.indexOf('=');
    if (arg.startsWith('--') && equals > 0) {
      token = arg.slice(0, equals);
      attached = arg.slice(equals + 1);
    } else if (!arg.startsWith('--') && arg.length > 2) {
      // pflag's attached shorthand: `-XPATCH` is `-X PATCH`. This is the form
      // that was missed, and it is why the table is consulted rather than a
      // list of literal tokens.
      token = arg.slice(0, 2);
      attached = arg.slice(2);
    }
    const spec = Object.hasOwn(table, token) ? table[token] : undefined;
    if (!spec) {
      return {
        refusal: `${token} is not an option eyes-on passes to gh, and a vector eyes-on cannot interpret with certainty is refused rather than read as a GET`,
      };
    }
    if (!spec.takesValue) {
      if (attached !== null) return { refusal: `${token} takes no value, so "${arg}" is not a vector eyes-on can interpret` };
      continue;
    }
    const value = attached ?? args[index + 1];
    if (value === undefined) return { refusal: `${token} was given no value` };
    if (attached === null) index += 1;
    values.set(spec.name, value);
  }
  return { values, operands };
}

/** The reason an invocation is refused, or null when it is allowed. */
export function refusalFor(args: readonly string[]): string | null {
  const verb = args[0];
  if (verb === undefined) return 'no gh command was given';

  // `gh repo view` reads; it has no writing form.
  if (verb === 'repo' && args[1] === 'view') {
    const parsed = parseArgv(args.slice(2), REPO_VIEW_FLAGS);
    if ('refusal' in parsed) return parsed.refusal;
    return parsed.operands.length === 0
      ? null
      : `gh repo view names ${parsed.operands[0]}; eyes-on reads only the clone it is run in`;
  }
  // `gh auth status` reads a credential and names no repository. It is here so
  // that `doctor`'s readiness probe goes through this door like everything
  // else, rather than being the one invocation the guarantee excepts.
  if (verb === 'auth' && args[1] === 'status') {
    return args.length === 2 ? null : 'gh auth status is run with no options here';
  }
  if (verb !== 'api') {
    return `only \`gh api\`, \`gh repo view\` and \`gh auth status\` are permitted; ${verb} is not`;
  }

  const parsed = parseArgv(args.slice(1), API_FLAGS);
  if ('refusal' in parsed) return parsed.refusal;
  if (parsed.operands.length === 0) return 'no endpoint path was given';
  if (parsed.operands.length > 1) {
    return `gh api takes one endpoint and ${parsed.operands.length} were given, so which one this would call cannot be determined`;
  }
  const path = parsed.operands[0] as string;
  const method = (parsed.values.get('method') ?? 'GET').toUpperCase();

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
    return gh(['auth', 'status'], { timeoutMs: 10_000 }).status === 0;
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
  const result = gh(['api', '--method', 'POST', `repos/${slug}/issues/${number}/comments`, '--input', '-'], {
    cwd: clonePath,
    input: JSON.stringify({ body }),
  });
  if (result.status !== 0) {
    throw GhError.remote(`gh could not comment on ${slug}#${number}`, result.status, result.stderr);
  }
  return parseComments(`[${result.stdout}]`)[0] ?? null;
}

export function updateComment(clonePath: string, slug: string, id: number, body: string): IssueComment | null {
  const result = gh(['api', '--method', 'PATCH', `repos/${slug}/issues/comments/${id}`, '--input', '-'], {
    cwd: clonePath,
    input: JSON.stringify({ body }),
  });
  if (result.status !== 0) {
    throw GhError.remote(`gh could not update comment ${id} on ${slug}`, result.status, result.stderr);
  }
  return parseComments(`[${result.stdout}]`)[0] ?? null;
}
