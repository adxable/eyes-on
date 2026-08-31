import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** A temporary directory removed when the test process exits. */
export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `eyes-on-${prefix}-`)));
  cleanups.push(dir);
  return dir;
}

const cleanups: string[] = [];
process.on('exit', () => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

export interface TempRepo {
  path: string;
  commit: (message: string, file?: string, contents?: string) => string;
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
      writeFileSync(join(path, file), `${contents}\n`);
      run(path, ['add', '-A']);
      run(path, ['commit', '-q', '-m', message]);
      return run(path, ['rev-parse', 'HEAD']).trim();
    },
  };
  repo.commit('seed');
  return repo;
}

export function run(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}
