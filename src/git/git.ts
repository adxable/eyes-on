import { spawnSync } from 'node:child_process';

/**
 * Every git invocation eyes-on makes goes through here, and the reason is
 * report K2: eyes-on may read the captain's working clone and must never write
 * to it.
 *
 * `git()` itself is deliberately module-private, so no caller outside this file
 * can choose an arbitrary working directory. A clone is reachable through
 * exactly two exported doors:
 *
 *   - `gitReadClone()`, which refuses any subcommand outside the read-only
 *     allow-list below, and - for the three subcommands that read or write
 *     depending on how they are invoked - refuses their write forms too;
 *   - `fetchCloneIntoMirror()`, the one sanctioned invocation that names a clone
 *     without running inside it - the clone is the fetch *source*, read through
 *     upload-pack, and every byte written lands in eyes-on's own mirror.
 *
 * Everything else targets the mirror, which is ours.
 */

/** Subcommands eyes-on is allowed to run against a working clone. Anything that
 *  moves a ref, touches the index, rewrites the worktree, or repacks objects is
 *  deliberately absent. Three entries here - `config`, `remote` and
 *  `symbolic-ref` - are read-only only in some of their forms, so the
 *  allow-list alone is not enough for them; see WRITE_FORM_GUARDS. */
export const CLONE_READ_ONLY_SUBCOMMANDS: readonly string[] = [
  'blame',
  'cat-file',
  'config',
  'diff',
  'for-each-ref',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'remote',
  'rev-list',
  'rev-parse',
  'show',
  'show-ref',
  'status',
  'symbolic-ref',
  'var',
  'version',
];

export class GitError extends Error {
  readonly status: number;
  readonly stderr: string;
  constructor(args: string[], status: number, stderr: string) {
    super(`git ${args.join(' ')} failed (${status}): ${stderr.trim()}`);
    this.name = 'GitError';
    this.status = status;
    this.stderr = stderr;
  }
}

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Working directory for the invocation. Never a foreign worktree. */
  cwd?: string;
  /** Explicit --git-dir, used for the mirror. */
  gitDir?: string;
  /** Throw on non-zero exit instead of returning the result. */
  check?: boolean;
  timeoutMs?: number;
}

function git(args: string[], options: GitOptions = {}): GitResult {
  const full = options.gitDir ? ['--git-dir', options.gitDir, ...args] : args;
  const result = spawnSync('git', full, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    env: {
      ...process.env,
      // Never let a repo-local or global hook, pager, or editor run inside a
      // read of someone else's clone.
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
  if (result.error) {
    throw new GitError(full, -1, String(result.error.message ?? result.error));
  }
  const out: GitResult = {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  if (options.check && out.status !== 0) {
    throw new GitError(full, out.status, out.stderr);
  }
  return out;
}

/**
 * `git config` writes unless it is asked to read. Requiring one of the reading
 * options refuses `config <key> <value>`, `--add`, `--unset` and `--edit`
 * without having to enumerate every writing option git may grow.
 */
const CONFIG_READ_OPTIONS = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--get-color',
  '--get-colorbool',
  '--list',
  '-l',
]);

/** `git remote` verbs that only report. Everything else - add, remove, rename,
 *  set-url, set-head, set-branches, prune, update - changes the clone. */
const REMOTE_READ_VERBS = new Set(['show', 'get-url']);

/**
 * The subcommands whose read/write nature depends on their arguments. Each
 * returns null when the invocation is a read, or the reason it is refused.
 */
const WRITE_FORM_GUARDS: Record<string, (rest: string[]) => string | null> = {
  config: (rest) =>
    rest.some((arg) => CONFIG_READ_OPTIONS.has(arg))
      ? null
      : `git config only reads a clone when asked to: pass one of ${[...CONFIG_READ_OPTIONS].join(', ')}`,
  remote: (rest) => {
    const verb = rest.find((arg) => !arg.startsWith('-'));
    return verb === undefined || REMOTE_READ_VERBS.has(verb)
      ? null
      : `git remote ${verb} changes the clone's remotes`;
  },
  'symbolic-ref': (rest) => {
    if (rest.includes('-d') || rest.includes('--delete')) return 'git symbolic-ref --delete removes a ref';
    const operands = rest.filter((arg) => !arg.startsWith('-'));
    return operands.length > 1 ? `git symbolic-ref ${operands.join(' ')} would point a ref somewhere else` : null;
  },
};

/**
 * Read-only invocation against a working clone. The subcommand is checked
 * against the allow-list, and the three subcommands that can write are checked
 * against their arguments too, before the process is spawned. This is the
 * regression test surface for K2, so it must fail loudly rather than be trusted
 * by review.
 */
export function gitReadClone(clonePath: string, args: string[], options: GitOptions = {}): GitResult {
  const subcommand = args.find((arg) => !arg.startsWith('-'));
  if (!subcommand || !CLONE_READ_ONLY_SUBCOMMANDS.includes(subcommand)) {
    throw new Error(
      `refusing to run "git ${subcommand ?? ''}" against a working clone: eyes-on only reads clones (see CLONE_READ_ONLY_SUBCOMMANDS)`,
    );
  }
  const guard = Object.hasOwn(WRITE_FORM_GUARDS, subcommand) ? WRITE_FORM_GUARDS[subcommand] : undefined;
  const refusal = guard?.(args.slice(args.indexOf(subcommand) + 1)) ?? null;
  if (refusal !== null) {
    throw new Error(
      `refusing to run "git ${args.join(' ')}" against a working clone: eyes-on only reads clones (${refusal})`,
    );
  }
  return git(args, { ...options, cwd: clonePath });
}

/**
 * Git against eyes-on's own mirror. The mirror is a rebuildable cache eyes-on
 * owns outright, so writes here are unremarkable - `--git-dir` keeps them there.
 */
export function gitMirror(mirrorPath: string, args: string[], options: GitOptions = {}): GitResult {
  return git(args, { ...options, gitDir: mirrorPath, cwd: undefined });
}

/** Creates the bare mirror repository itself, before it has a git dir to name. */
export function initBareMirror(mirrorPath: string): GitResult {
  return git(['init', '--bare', '--quiet', mirrorPath], { check: true });
}

/**
 * Fetches the clone's heads into the mirror. This is the single exception to
 * "eyes-on only ever runs allow-listed subcommands against a clone", and it is
 * an exception in name only: `--git-dir` is the mirror, the process never runs
 * inside the clone, and the clone is touched exactly the way any `git fetch
 * <path>` touches its source - a read through upload-pack. No ref, index entry
 * or config value in the clone moves.
 */
export function fetchCloneIntoMirror(mirrorPath: string, clonePath: string, refspec: string): GitResult {
  return git(['fetch', '--quiet', '--no-tags', '--prune', clonePath, refspec], {
    gitDir: mirrorPath,
    check: true,
  });
}

export function isGitRepo(path: string): boolean {
  return gitReadClone(path, ['rev-parse', '--is-inside-work-tree']).status === 0;
}

/** Absolute top level of the working tree containing path. */
export function toplevel(path: string): string | null {
  const result = gitReadClone(path, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * The shared object store of the clone. For a plain checkout this is
 * `<top>/.git/objects`; for a linked worktree it is the *common* dir's objects,
 * which is exactly what the mirror's alternates file must point at - a
 * per-worktree git dir holds no objects of its own.
 */
export function commonGitDir(path: string): string | null {
  const result = gitReadClone(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/** Hooks directory git would actually consult for this repository. */
export function hooksDir(path: string): string | null {
  const configured = gitReadClone(path, ['config', '--get', 'core.hooksPath']);
  if (configured.status === 0 && configured.stdout.trim().length > 0) {
    const value = configured.stdout.trim();
    if (value.startsWith('/')) return value;
    const top = toplevel(path);
    return top ? `${top}/${value}` : null;
  }
  const common = commonGitDir(path);
  return common ? `${common}/hooks` : null;
}

export function currentBranch(path: string): string | null {
  const result = gitReadClone(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.status !== 0) return null;
  const branch = result.stdout.trim();
  return branch === 'HEAD' || branch.length === 0 ? null : branch;
}

export function headSHA(path: string): string | null {
  const result = gitReadClone(path, ['rev-parse', 'HEAD']);
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Best-effort default branch: the remote HEAD if origin publishes one, else
 * whichever of the conventional names exists, else the current branch.
 * Resolved without contacting the network.
 */
export function defaultBranch(path: string): string {
  const remoteHead = gitReadClone(path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead.status === 0) {
    const value = remoteHead.stdout.trim();
    const slash = value.lastIndexOf('/');
    if (slash >= 0) return value.slice(slash + 1);
  }
  for (const candidate of ['main', 'master']) {
    if (gitReadClone(path, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]).status === 0) {
      return candidate;
    }
  }
  return currentBranch(path) ?? 'main';
}

export function gitVersion(): string | null {
  const result = git(['version']);
  return result.status === 0 ? result.stdout.trim() : null;
}
