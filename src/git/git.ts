import { spawnSync } from 'node:child_process';

/**
 * Every git invocation eyes-on makes goes through here, and the reason is
 * report K2: eyes-on may read the captain's working clone and must never write
 * to it. Routing all of git through one function makes that auditable - a
 * single allow-list, one place to test, and no second path where a stray
 * `checkout` could appear.
 */

/** Subcommands eyes-on is allowed to run against a working clone. Read-only,
 *  every one of them. Anything that moves a ref, touches the index, rewrites
 *  the worktree, or repacks objects is deliberately absent. */
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

export function git(args: string[], options: GitOptions = {}): GitResult {
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
 * Read-only invocation against a working clone. The subcommand is checked
 * against the allow-list before the process is spawned: this is the regression
 * test surface for K2, so it must fail loudly rather than be trusted by review.
 */
export function gitReadClone(clonePath: string, args: string[], options: GitOptions = {}): GitResult {
  const subcommand = args.find((arg) => !arg.startsWith('-'));
  if (!subcommand || !CLONE_READ_ONLY_SUBCOMMANDS.includes(subcommand)) {
    throw new Error(
      `refusing to run "git ${subcommand ?? ''}" against a working clone: eyes-on only reads clones (see CLONE_READ_ONLY_SUBCOMMANDS)`,
    );
  }
  return git(args, { ...options, cwd: clonePath });
}

export function isGitRepo(path: string): boolean {
  return git(['rev-parse', '--is-inside-work-tree'], { cwd: path }).status === 0;
}

/** Absolute top level of the working tree containing path. */
export function toplevel(path: string): string | null {
  const result = git(['rev-parse', '--show-toplevel'], { cwd: path });
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
  const result = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: path });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/** Hooks directory git would actually consult for this repository. */
export function hooksDir(path: string): string | null {
  const configured = git(['config', '--get', 'core.hooksPath'], { cwd: path });
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
  const result = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path });
  if (result.status !== 0) return null;
  const branch = result.stdout.trim();
  return branch === 'HEAD' || branch.length === 0 ? null : branch;
}

export function headSHA(path: string): string | null {
  const result = git(['rev-parse', 'HEAD'], { cwd: path });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Best-effort default branch: the remote HEAD if origin publishes one, else
 * whichever of the conventional names exists, else the current branch.
 * Resolved without contacting the network.
 */
export function defaultBranch(path: string): string {
  const remoteHead = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: path });
  if (remoteHead.status === 0) {
    const value = remoteHead.stdout.trim();
    const slash = value.lastIndexOf('/');
    if (slash >= 0) return value.slice(slash + 1);
  }
  for (const candidate of ['main', 'master']) {
    if (git(['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], { cwd: path }).status === 0) {
      return candidate;
    }
  }
  return currentBranch(path) ?? 'main';
}

export function gitVersion(): string | null {
  const result = git(['version']);
  return result.status === 0 ? result.stdout.trim() : null;
}
