import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { PRODUCT_NAME } from './version.js';

/**
 * Filesystem layout of the eyes-on state root (report Appendix C.2).
 *
 * The root defaults to ~/.eyes-on and is overridden by EYES_HOME. Under the
 * test runner the default root is refused outright: the first test that ran
 * against ~/.eyes-on would clobber the captain's ledger. no-mistakes learned
 * the same lesson (internal/paths/paths.go:19-30) and we copy the guard rather
 * than the mistake.
 */
export class Paths {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /** Root from EYES_HOME, else ~/.eyes-on. Throws under `node --test` unless
   *  EYES_ON_ALLOW_DEFAULT_ROOT_IN_TESTS=1 is set explicitly. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): Paths {
    const override = env.EYES_HOME;
    if (override && override.length > 0) {
      return new Paths(resolve(override));
    }
    if (env.NODE_TEST_CONTEXT && env.EYES_ON_ALLOW_DEFAULT_ROOT_IN_TESTS !== '1') {
      throw new Error(
        'EYES_HOME must be set under the test runner so tests cannot touch the real eyes-on state root',
      );
    }
    return new Paths(join(homedir(), `.${PRODUCT_NAME}`));
  }

  /** Root at an explicit directory (daemon run --root, tests). */
  static withRoot(root: string): Paths {
    return new Paths(resolve(root));
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
  get socket(): string {
    return join(this.root, 'socket');
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
