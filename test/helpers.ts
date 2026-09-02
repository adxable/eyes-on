import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** A temporary directory removed when the test process exits. */
export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `eyes-on-${prefix}-`)));
  cleanups.push(dir);
  return dir;
}

/**
 * Base for temporary state roots. Deliberately NOT `os.tmpdir()`.
 *
 * A state root has to be short enough to hold its own unix socket address
 * (`MAX_SOCKET_PATH_BYTES`), and `os.tmpdir()` is not: a macOS per-user
 * temporary directory is already about fifty bytes, and a host with a deeper
 * TMPDIR would push every test root past the limit and fail the whole suite for
 * a reason that has nothing to do with the code under test. `/tmp` is mandated
 * by POSIX and is a fixed four bytes, so a root under it is short on every
 * machine. `EYES_ON_TEST_ROOT_BASE` exists for a host where `/tmp` is not
 * usable.
 */
const STATE_ROOT_BASE = process.env.EYES_ON_TEST_ROOT_BASE ?? '/tmp';

/** A short, private directory under `STATE_ROOT_BASE`, removed on exit. */
export function shortDir(): string {
  mkdirSync(STATE_ROOT_BASE, { recursive: true });
  const dir = mkdtempSync(join(STATE_ROOT_BASE, 'eo-'));
  cleanups.push(dir);
  return dir;
}

/**
 * A state root for a test, short on any machine and removed on exit.
 *
 * The root itself is not created - `init` and the daemon create it - but its
 * parent is, so the path is stable before anything writes there.
 */
export function stateRoot(leaf = 'eyes-on'): string {
  return join(shortDir(), leaf);
}

const cleanups: string[] = [];
process.on('exit', () => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

export interface TempRepo {
  path: string;
  commit: (message: string, file?: string, contents?: string) => string;
  /** A commit touching several files at once, optionally back-dated. Dates
   *  matter to every history signal, so a test that needs one says so. */
  commitFiles: (message: string, files: Record<string, string | null>, whenISO?: string) => string;
  branch: (name: string) => void;
  checkout: (name: string) => void;
  git: (args: string[]) => string;
}

/** A throwaway git repository with one commit. Never a repository owned by
 *  anybody else: every test that touches git works on one of these. */
export function tempRepo(prefix = 'repo'): TempRepo {
  const path = tempDir(prefix);
  run(path, ['init', '-q', '-b', 'main', '.']);
  run(path, ['config', 'user.email', 'test@example.invalid']);
  run(path, ['config', 'user.name', 'eyes-on tests']);
  run(path, ['config', 'commit.gpgsign', 'false']);
  const repo: TempRepo = {
    path,
    commit(message, file = 'file.txt', contents = message) {
      return repo.commitFiles(message, { [file]: contents });
    },
    commitFiles(message, files, whenISO) {
      for (const [name, contents] of Object.entries(files)) {
        const full = join(path, name);
        if (contents === null) {
          rmSync(full, { force: true });
          continue;
        }
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents.endsWith('\n') ? contents : `${contents}\n`);
      }
      run(path, ['add', '-A']);
      const env = whenISO ? { GIT_AUTHOR_DATE: whenISO, GIT_COMMITTER_DATE: whenISO } : undefined;
      run(path, ['commit', '-q', '--allow-empty', '-m', message], env);
      return run(path, ['rev-parse', 'HEAD']).trim();
    },
    branch(name) {
      run(path, ['branch', name]);
    },
    checkout(name) {
      run(path, ['checkout', '-q', name]);
    },
    git(args) {
      return run(path, args);
    },
  };
  repo.commit('seed');
  return repo;
}

export function run(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}
