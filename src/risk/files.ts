import { matchesAny, normalizePath } from '../core/glob.js';
import type { RepoConfig } from './repoconfig.js';

/**
 * Which files count as code, and which changed files are tests.
 *
 * The code filter is the noise filter, and it is a measured requirement: on the
 * reference repository, ranking files without it puts `AGENTS.md` at number one
 * (report section 8, stage 1). Documentation and log-shaped data files churn
 * constantly and attract fixes constantly, and sending a reviewer to them
 * teaches them to ignore the ranking - which is the failure mode the research
 * report calls out for heuristic signals generally (section 1.3, and the
 * Tricorder lesson in its section 4).
 *
 * `exclude` wins over `include`, so a generated TypeScript file is not code
 * however it is named.
 */

export interface FileFilter {
  isCode(path: string): boolean;
  include: readonly string[];
  exclude: readonly string[];
}

export function fileFilter(config: RepoConfig): FileFilter {
  return {
    include: config.include,
    exclude: config.exclude,
    isCode(path: string): boolean {
      const clean = normalizePath(path);
      if (matchesAny(clean, config.exclude)) return false;
      return matchesAny(clean, config.include);
    },
  };
}

/**
 * Test files, recognised by the conventions of the languages the default
 * `include` covers.
 *
 * This is a heuristic and is used only for the S5 signal, which asks whether a
 * change brought a test with it. A miss weakens one signal at weight 0.15; it
 * cannot send a change to the wrong band on its own.
 */
const TEST_PATTERNS: readonly string[] = [
  '**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}',
  '**/*_test.{go,py,rb,ts,js}',
  '**/test_*.py',
  '**/*Test.{java,kt,cs,scala}',
  '**/*Tests.{java,kt,cs,scala}',
  '**/*_spec.rb',
  '**/{test,tests,spec,__tests__,testdata}/**',
];

export function isTestFile(path: string): boolean {
  return matchesAny(normalizePath(path), TEST_PATTERNS);
}

/**
 * The stem a test file and the file it tests share.
 *
 * `src/foo/bar.test.ts` and `src/foo/bar.ts` both reduce to `bar`, and so do
 * `bar_test.go`, `test_bar.py` and `BarTest.java`. Deliberately basename-only:
 * a repository that keeps tests in a parallel `test/` tree is the common case,
 * and requiring the directories to agree would report "no test" for most of
 * them.
 */
export function testStem(path: string): string {
  const base = normalizePath(path).split('/').pop() ?? '';
  const withoutExtension = base.replace(/\.[^.]+$/, '');
  return withoutExtension
    .replace(/\.(test|spec)$/i, '')
    .replace(/_(test|spec)$/i, '')
    .replace(/^test_/i, '')
    .replace(/(Test|Tests|Spec)$/, '')
    .toLowerCase();
}

/** Directory of a path, or `.` for a file at the repository root. Used for the
 *  spread signal, which counts how many places a change reaches into. */
export function directoryOf(path: string): string {
  const clean = normalizePath(path);
  const slash = clean.lastIndexOf('/');
  return slash < 0 ? '.' : clean.slice(0, slash);
}
