import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PRODUCT_NAME } from './version.js';

/**
 * Largest unix-socket address eyes-on will bind directly. The kernel field is
 * 104 bytes on macOS and 108 on Linux; the smaller of the two is used
 * everywhere so a state root behaves the same on both, and a few bytes are left
 * spare rather than sitting exactly on the boundary.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

/**
 * A relocated socket may not sit directly in the shared temporary directory.
 *
 * `/tmp` on Linux is world-writable, and the relocated address is derived from
 * the state root by a published rule - so anyone able to guess the root (a CI
 * or sandbox root is predictable) could bind that path first and then answer
 * every client's JSON-RPC call, including the `init` call that carries the
 * clone's path. The socket's own 0700 mode protects it only once eyes-on owns
 * it, not the name it is about to take.
 *
 * The directory below is what removes that: one per user, created 0700, and
 * refused if it is anything else. It is still derived from nothing but the
 * state root and the calling user, so the daemon and every client still agree
 * on the address without coordinating - which is the property that stopped two
 * deep roots from silently sharing one daemon.
 */
export function privateSocketDirName(): string {
  return `${PRODUCT_NAME}-${userInfo().uid}`;
}

/** Mode a socket directory outside the state root must have: nothing for group
 *  or other, since eyes-on creates it 0700 itself. */
const SOCKET_DIR_MODE = 0o700;

/**
 * A socket directory that exists but is not ours to trust.
 *
 * Both remedies have to work from the state this is raised in, which is why
 * there are two: a directory this user owns can be repaired in place, and one
 * owned by somebody else cannot be touched at all - so the second remedy
 * removes the need for the directory instead. A state root short enough to hold
 * its own socket never consults this path.
 */
export class SocketDirectoryError extends Error {
  readonly help: string[];
  constructor(dir: string, reason: string) {
    super(`the directory eyes-on would put its daemon socket in, ${dir}, ${reason}`);
    this.name = 'SocketDirectoryError';
    this.help = [
      `If ${dir} is yours, remove it or run \`chmod 700 ${dir}\`: eyes-on needs a directory owned by this user with mode 0700`,
      `If it is not yours to change, set EYES_HOME to a state root of at most ${MAX_SOCKET_PATH_BYTES - '/socket'.length} bytes, which keeps the socket inside the state root and never uses this directory`,
    ];
  }
}

/**
 * Refuses a relocated socket directory that another user could write into.
 *
 * A directory that does not exist yet is not a fault - there is simply no
 * daemon, and `RpcServer.listen` creates it 0700 before binding. What is a
 * fault is one that exists and is not a directory we own privately, because
 * then the address is somebody else's to claim.
 */
export function assertPrivateSocketDir(dir: string): void {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch {
    return;
  }
  if (!stats.isDirectory()) {
    throw new SocketDirectoryError(dir, 'is not a directory');
  }
  if (typeof stats.uid === 'number' && stats.uid !== userInfo().uid) {
    throw new SocketDirectoryError(dir, `is owned by uid ${stats.uid}, not by this user`);
  }
  if ((stats.mode & ~SOCKET_DIR_MODE & 0o777) !== 0) {
    throw new SocketDirectoryError(
      dir,
      `is reachable by other users (mode ${(stats.mode & 0o777).toString(8).padStart(4, '0')}, expected 0700)`,
    );
  }
}

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
 * The root defaults to ~/.eyes-on and is overridden by EYES_HOME. Two roots are
 * refused rather than used, both at construction so no command can proceed to
 * write into one:
 *
 *   - the default root under the test runner, because the first test that ran
 *     against ~/.eyes-on would clobber the captain's ledger. no-mistakes learned
 *     the same lesson (internal/paths/paths.go:19-30) and we copy the guard
 *     rather than the mistake;
 *   - any root inside the no-mistakes state root, which is the product's first
 *     hard prohibition and not a preference.
 */
export class Paths {
  readonly root: string;

  private constructor(root: string, env: NodeJS.ProcessEnv) {
    const foreign = foreignStateRoot(env);
    if (isInsideStateRoot(root, foreign)) {
      throw new ForeignStateRootError(root, foreign);
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
   * The daemon's control socket.
   *
   * Normally `<root>/socket`. A unix domain socket address is a fixed-size
   * field in the kernel - 104 bytes on macOS, 108 on Linux - and an address
   * longer than that is **truncated rather than refused**. Two state roots
   * whose paths agree for the first hundred bytes then bind and connect to the
   * same address, and the symptom is not an error: `eyes-on init` under one
   * root registers the repository into another root's database and mirror while
   * reporting the root it was given. That was measured, not imagined.
   *
   * So a root whose socket would not fit gets a short address instead, derived
   * from a hash of the canonical root so that the daemon and every client
   * compute the same one without having to agree on anything else. It lives in
   * a per-user directory (`privateSocketDirName`) rather than loose in the
   * shared temporary directory, and that directory is refused unless it is ours
   * and private. The default root (`~/.eyes-on`) is nowhere near the limit;
   * this is for the deep temporary roots that tests, sandboxes and measurement
   * sessions live in.
   */
  get socket(): string {
    const direct = join(this.root, 'socket');
    if (Buffer.byteLength(direct, 'utf8') <= MAX_SOCKET_PATH_BYTES) return direct;
    const digest = createHash('sha256').update(this.canonicalRoot()).digest('hex').slice(0, 12);
    const file = `${PRODUCT_NAME}-${digest}.sock`;
    let directory = join(tmpdir(), privateSocketDirName());
    // `/tmp` is the last resort: a macOS per-user temporary directory is itself
    // long enough to overflow the field on a deep root.
    if (Buffer.byteLength(join(directory, file), 'utf8') > MAX_SOCKET_PATH_BYTES) {
      directory = `/tmp/${privateSocketDirName()}`;
    }
    assertPrivateSocketDir(directory);
    return join(directory, file);
  }

  /** True when the socket had to move out of the state root. `doctor` says so,
   *  because a socket that is not where the layout says it is must not be a
   *  surprise to whoever is debugging a daemon. */
  get socketIsOutsideRoot(): boolean {
    return this.socket !== join(this.root, 'socket');
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
