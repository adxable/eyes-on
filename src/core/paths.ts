import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { PRODUCT_NAME } from './version.js';

/**
 * Largest unix-socket address eyes-on will bind. The kernel field is 104 bytes
 * on macOS and 108 on Linux; the smaller of the two is used everywhere so a
 * state root behaves the same on both, and a few bytes are left spare rather
 * than sitting exactly on the boundary.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

/** The socket file's name inside the state root. */
const SOCKET_NAME = 'socket';

/** The no-mistakes state root this machine uses: NM_HOME, else ~/.no-mistakes. */
export function foreignStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.NM_HOME;
  return override && override.length > 0 ? resolve(override) : join(homedir(), '.no-mistakes');
}

/**
 * The physical spelling of a path that need not exist yet: the deepest existing
 * ancestor is resolved through its symlinks and the remainder appended. A
 * containment test on lexical paths alone can be walked around with a symlink,
 * and one that requires the path to exist cannot answer before `init` creates
 * it - both matter here, because the answer decides whether anything is written
 * at all.
 */
export function physicalPath(path: string): string {
  const absolute = resolve(path);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/** True when `candidate` is `root` itself or lies anywhere beneath it. */
export function isInsideStateRoot(candidate: string, root: string): boolean {
  const inner = physicalPath(candidate);
  const outer = physicalPath(root);
  return inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : `${outer}${sep}`);
}

/**
 * A state root whose socket address the kernel would silently truncate.
 *
 * A unix domain socket address is a fixed-size field - 104 bytes on macOS, 108
 * on Linux - and an address longer than that is truncated rather than refused.
 * Two state roots whose paths agree for the first hundred bytes then bind and
 * connect to the same address, and the symptom is not an error: `eyes-on init`
 * under one root registers the repository into another root's database and
 * mirror while reporting the root it was given. That was measured, not
 * imagined.
 *
 * The root is refused where it is resolved, before any command can bind or
 * connect. eyes-on does not relocate the socket to make a deep root work: an
 * address derived from anywhere but the state root is one more thing that can
 * disagree between the daemon and its clients.
 */
export class SocketPathTooLongError extends Error {
  readonly help: string[];
  constructor(root: string, socketPath: string) {
    super(
      `the eyes-on state root ${root} is too deep to hold a daemon socket: ${socketPath} is ${Buffer.byteLength(socketPath, 'utf8')} bytes and a unix socket address may be at most ${MAX_SOCKET_PATH_BYTES}`,
    );
    this.name = 'SocketPathTooLongError';
    this.help = [
      `Set EYES_HOME to a directory of at most ${MAX_SOCKET_PATH_BYTES - SOCKET_NAME.length - 1} bytes, for example \`EYES_HOME=~/.eyes-on\``,
      'A longer address is truncated rather than refused by the kernel, so two deep roots would silently share one daemon',
    ];
  }
}

/**
 * A state root that would put eyes-on's own writes inside somebody else's.
 *
 * The first hard prohibition of this product is that it writes nothing under
 * `~/.no-mistakes/**`, and every file eyes-on writes lives under its state
 * root - so a root nested there breaks the prohibition on the next write,
 * whatever the file is called. Resolving the root is where it is refused,
 * because that happens before any command can act.
 */
export class ForeignStateRootError extends Error {
  readonly help: string[];
  constructor(root: string, foreignRoot: string) {
    super(
      `the eyes-on state root ${root} is inside the no-mistakes state root ${foreignRoot}, and eyes-on never writes anything under it`,
    );
    this.name = 'ForeignStateRootError';
    this.help = [
      'Set EYES_HOME to a directory outside the no-mistakes state root, for example `EYES_HOME=~/.eyes-on`',
      'Leave EYES_HOME unset to use the default root ~/.eyes-on',
    ];
  }
}

/**
 * Filesystem layout of the eyes-on state root (report Appendix C.2).
 *
 * The root defaults to ~/.eyes-on and is overridden by EYES_HOME. Three roots
 * are refused rather than used, all at construction so no command can proceed
 * to write into one:
 *
 *   - the default root under the test runner, because the first test that ran
 *     against ~/.eyes-on would clobber the captain's ledger. no-mistakes learned
 *     the same lesson (internal/paths/paths.go:19-30) and we copy the guard
 *     rather than the mistake;
 *   - any root inside the no-mistakes state root, which is the product's first
 *     hard prohibition and not a preference;
 *   - any root too deep for `<root>/socket` to be a bindable unix socket
 *     address, because the kernel truncates such an address instead of
 *     refusing it.
 */
export class Paths {
  readonly root: string;

  private constructor(root: string, env: NodeJS.ProcessEnv) {
    const foreign = foreignStateRoot(env);
    if (isInsideStateRoot(root, foreign)) {
      throw new ForeignStateRootError(root, foreign);
    }
    const socket = join(root, SOCKET_NAME);
    if (Buffer.byteLength(socket, 'utf8') > MAX_SOCKET_PATH_BYTES) {
      throw new SocketPathTooLongError(root, socket);
    }
    this.root = root;
  }

  /** Root from EYES_HOME, else ~/.eyes-on. Throws under `node --test` unless
   *  EYES_ON_ALLOW_DEFAULT_ROOT_IN_TESTS=1 is set explicitly. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Paths {
    const override = env.EYES_HOME;
    if (override && override.length > 0) {
      return new Paths(resolve(override), env);
    }
    if (env.NODE_TEST_CONTEXT && env.EYES_ON_ALLOW_DEFAULT_ROOT_IN_TESTS !== '1') {
      throw new Error(
        'EYES_HOME must be set under the test runner so tests cannot touch the real eyes-on state root',
      );
    }
    return new Paths(join(homedir(), `.${PRODUCT_NAME}`), env);
  }

  /** Root at an explicit directory (daemon run --root, tests). */
  static withRoot(root: string, env: NodeJS.ProcessEnv = process.env): Paths {
    return new Paths(resolve(root), env);
  }

  get configFile(): string {
    return join(this.root, 'config.yaml');
  }
  get db(): string {
    return join(this.root, 'state.sqlite');
  }
  get ledger(): string {
    return join(this.root, 'ledger.jsonl');
  }
  /**
   * The daemon's control socket, always inside the state root.
   *
   * A root that cannot hold one is refused when it is resolved
   * (`SocketPathTooLongError`), so this is unconditional: there is exactly one
   * address, every client derives it the same way, and nothing outside the
   * state root is ever consulted.
   */
  get socket(): string {
    return join(this.root, SOCKET_NAME);
  }

  /**
   * OS-level exclusive lock enforcing one live daemon per root. Distinct from
   * pidFile, which is an informational record for status consumers: the lock
   * is what actually prevents two daemons from binding the same socket.
   */
  get lockFile(): string {
    return join(this.root, 'daemon.lock');
  }
  get pidFile(): string {
    return join(this.root, 'daemon.pid');
  }
  get logsDir(): string {
    return join(this.root, 'logs');
  }
  get daemonLog(): string {
    return join(this.logsDir, 'daemon.log');
  }
  get cliLog(): string {
    return join(this.logsDir, 'cli.log');
  }
  get mirrorsDir(): string {
    return join(this.root, 'mirrors');
  }
  mirrorDir(repoID: string): string {
    return join(this.mirrorsDir, `${repoID}.git`);
  }
  get reportsDir(): string {
    return join(this.root, 'reports');
  }
  reportFile(headSHA: string): string {
    return join(this.reportsDir, `${headSHA}.json`);
  }

  /**
   * Physical form of the root, used wherever two spellings of the same
   * directory must compare equal - most importantly the service label hash, so
   * `eyes-on daemon start` and a LaunchAgent installed earlier agree on which
   * service they are talking about.
   */
  canonicalRoot(): string {
    try {
      return realpathSync(this.root);
    } catch {
      return this.root;
    }
  }
}

/** Directories that must exist before anything writes into the root. */
export const STATE_SUBDIRS = ['logs', 'mirrors', 'reports'] as const;
