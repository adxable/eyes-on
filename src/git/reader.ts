import { existsSync } from 'node:fs';
import { gitMirror, gitReadClone, GitError, type GitResult } from './git.js';
import { inspectMirror } from './mirror.js';
import { normalizePath } from '../core/glob.js';

/**
 * The single reader every risk computation goes through.
 *
 * Two properties are the whole reason it exists.
 *
 * **Where it reads.** The report is explicit (section 5, P1): read the mirror,
 * fall back to the clone through `--git-dir`, and never a run's worktree. The
 * mirror borrows the clone's object store through `objects/info/alternates`, so
 * any object the clone holds is readable through the mirror *by SHA* - even one
 * committed after the last fetch. What the mirror does not have is the clone's
 * ref names, and it must not: they are the clone's. So this reader resolves
 * every ref against the clone and then does all of its reading by SHA, which
 * removes ref drift from the picture entirely rather than papering over it.
 *
 * **How it reads.** Reads against the clone go through `gitReadClone`, the
 * allow-listed door; there is no other way in from here. That is what makes
 * "eyes-on never writes to a working clone" a property of the code rather than
 * of anyone's care.
 */

export interface ReaderOptions {
  clonePath: string;
  mirrorPath: string;
  /** Raised for a full history walk on a large repository. */
  timeoutMs?: number;
}

export interface ChangedFile {
  path: string;
  /** Path before a rename, when git reported one. */
  previousPath: string | null;
  added: number;
  deleted: number;
  /** True for a file git could not count lines for, which in practice is a
   *  binary file. Its lines are counted as zero rather than guessed. */
  binary: boolean;
}

export interface CommitRecord {
  sha: string;
  /** Author timestamp, seconds since the epoch. */
  timestamp: number;
  subject: string;
  parents: string[];
  files: ChangedFile[];
}

export class RepoReader {
  readonly clonePath: string;
  readonly mirrorPath: string;
  private readonly timeoutMs: number;
  private readonly mirrorUsable: boolean;

  constructor(options: ReaderOptions) {
    this.clonePath = options.clonePath;
    this.mirrorPath = options.mirrorPath;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    const status = existsSync(options.mirrorPath) ? inspectMirror(options.mirrorPath) : null;
    // A mirror whose alternate has gone is a broken cache, not a source: it
    // holds refs pointing at objects nobody can read. `doctor` reports it and
    // `init --force` rebuilds it; until then reads fall back to the clone.
    this.mirrorUsable = status !== null && status.exists && status.alternateReachable;
  }

  /** Where this reader is actually reading from, for `doctor` and for the
   *  provenance line every report carries. */
  get source(): 'mirror' | 'clone' {
    return this.mirrorUsable ? 'mirror' : 'clone';
  }

  /** Object-level read, mirror first. Every argument must name an object by
   *  SHA rather than by a ref that only the clone knows. */
  private read(args: string[]): GitResult {
    if (this.mirrorUsable) {
      return gitMirror(this.mirrorPath, args, { timeoutMs: this.timeoutMs });
    }
    return gitReadClone(this.clonePath, args, { timeoutMs: this.timeoutMs });
  }

  private readOrThrow(args: string[]): string {
    const result = this.read(args);
    if (result.status !== 0) {
      throw new GitError(args, result.status, result.stderr);
    }
    return result.stdout;
  }

  /** Ref resolution happens against the clone, which is the only place the
   *  branch names live. Returns null for a ref this repository does not have. */
  resolve(rev: string): string | null {
    const result = gitReadClone(this.clonePath, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    const sha = result.stdout.trim();
    return result.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  /** True when the object store this reader uses actually holds the commit. */
  has(sha: string): boolean {
    return this.read(['cat-file', '-e', `${sha}^{commit}`]).status === 0;
  }

  mergeBase(a: string, b: string): string | null {
    const result = this.read(['merge-base', a, b]);
    const sha = result.stdout.trim();
    return result.status === 0 && sha.length > 0 ? sha : null;
  }

  /** File contents at a commit, or null when the path is absent there. Used for
   *  the trusted `.eyes-on.yml`, where "absent" and "unreadable" must not be
   *  confused with each other. */
  fileAt(sha: string, path: string): string | null {
    const result = this.read(['show', `${sha}:${path}`]);
    return result.status === 0 ? result.stdout : null;
  }

  /**
   * Changed files between two commits, with line counts.
   *
   * `--no-renames` is deliberate: a rename reported as one entry hides the fact
   * that a reviewer has two paths to think about, and the risk of the old path
   * is exactly the history the new one inherits. Renames are reported as a
   * delete plus an add, which is what the diff a human reads shows too.
   */
  changedFiles(baseSHA: string, headSHA: string): ChangedFile[] {
    const out = this.readOrThrow(['diff', '--numstat', '--no-renames', `${baseSHA}..${headSHA}`]);
    return parseNumstat(out);
  }

  /** Files a single commit changed, against its first parent. A root commit
   *  yields its whole tree, which is correct: everything in it is new. */
  commitFiles(sha: string): ChangedFile[] {
    const out = this.readOrThrow(['diff-tree', '--numstat', '--no-renames', '--root', '-m', '--first-parent', sha]);
    return parseNumstat(out);
  }

  /**
   * Commit history with per-file line counts, newest first.
   *
   * `--no-merges` is what makes the counts mean something: a merge commit's
   * diff against its first parent re-reports every line of the branch it
   * merges, so counting them would credit each change twice and hand the file
   * that happened to be merged most often the top of the ranking.
   */
  history(options: { sinceSeconds?: number; untilSeconds?: number; until: string; maxCount?: number }): CommitRecord[] {
    const args = ['log', '--no-merges', '--numstat', '--no-renames', '--date=unix', `--format=${LOG_FORMAT}`];
    if (options.sinceSeconds !== undefined) {
      args.push(`--since=${Math.floor(options.sinceSeconds)}`);
    }
    if (options.untilSeconds !== undefined) {
      args.push(`--until=${Math.floor(options.untilSeconds)}`);
    }
    if (options.maxCount !== undefined) {
      args.push(`--max-count=${options.maxCount}`);
    }
    args.push(options.until);
    return parseLog(this.readOrThrow(args));
  }

  /** The newest commit on `anchorSHA` no later than a moment in time. A
   *  backtest's split date is a moment; git needs a commit. */
  lastCommitBefore(anchorSHA: string, untilSeconds: number): string | null {
    const result = this.read([
      'log',
      '-1',
      '--format=%H',
      `--until=${Math.floor(untilSeconds)}`,
      anchorSHA,
    ]);
    const sha = result.stdout.trim();
    return result.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  /** One commit's metadata, without its diff. */
  commit(sha: string): CommitRecord | null {
    const out = this.read(['log', '-1', '--date=unix', `--format=${LOG_FORMAT}`, sha]);
    if (out.status !== 0) return null;
    const records = parseLog(out.stdout);
    return records[0] ?? null;
  }

  /**
   * The unified diff of one commit against its first parent, with no context.
   *
   * Zero context is what makes the hunk headers usable as SZZ input: with
   * context lines the `-<start>,<count>` range covers lines the commit never
   * touched, and blaming them would attribute somebody else's code to this fix.
   */
  commitPatch(sha: string): string {
    return this.readOrThrow(['diff-tree', '-p', '-U0', '--no-renames', '--first-parent', '-m', sha]);
  }

  /**
   * Commits that introduced the lines in `[start, end]` of `path` at `sha`.
   *
   * Rename and copy detection (`-M` / `-C`) is deliberately off. It costs a
   * multiple of the run time on a repository of any size, and the signal it
   * would improve is a file-level count where a moved line lands on the moved
   * file either way. `-w` is on: a re-indentation is not the introduction of a
   * defect, and treating it as one is the single easiest way to make this
   * signal noise.
   */
  blame(sha: string, path: string, start: number, end: number): string[] {
    const result = this.read([
      'blame',
      '--porcelain',
      '-w',
      `-L`,
      `${Math.max(1, start)},${Math.max(start, end)}`,
      sha,
      '--',
      path,
    ]);
    // A path that did not exist at that commit, or a range past its end, is an
    // ordinary outcome of walking history - not a failure worth stopping for.
    if (result.status !== 0) return [];
    return parseBlamePorcelain(result.stdout);
  }

  /**
   * The unified diff between two commits, with context.
   *
   * The context is what makes this different from `commitPatch`, which asks for
   * `-U0` because SZZ needs hunk ranges that name only the lines a fix touched.
   * The fragment ranking asks the opposite question - what would a human read -
   * and three lines either side is what makes a hunk legible as a fragment
   * rather than as a coordinate.
   */
  rangePatch(baseSHA: string, headSHA: string, context = 3): string {
    return this.readOrThrow([
      'diff',
      `-U${Math.max(0, Math.floor(context))}`,
      '--no-renames',
      '--no-color',
      `${baseSHA}..${headSHA}`,
    ]);
  }

  /**
   * Blame of several line ranges of one file at one commit, as line-to-commit
   * pairs.
   *
   * One invocation per file rather than per range: `git blame` accepts repeated
   * `-L` options, and the cost of a blame is dominated by walking the file's
   * history, which is paid once however many ranges are asked for. A ranking
   * that blamed once per hunk would pay it again for every hunk in the file.
   *
   * `-w` matches `blame()` above and for the same reason: a re-indentation is
   * not the introduction of a defect.
   */
  blameRanges(sha: string, path: string, ranges: readonly { start: number; end: number }[]): BlamedLine[] {
    if (ranges.length === 0) return [];
    const args = ['blame', '--porcelain', '-w'];
    for (const range of ranges) {
      args.push('-L', `${Math.max(1, range.start)},${Math.max(Math.max(1, range.start), range.end)}`);
    }
    args.push(sha, '--', path);
    const result = this.read(args);
    // A path absent at that commit, or a range past its end, is an ordinary
    // outcome of reading a diff whose other side is a creation.
    if (result.status !== 0) return [];
    return parseBlamedLines(result.stdout);
  }

  /** Every path in the tree at a commit. The denominator of a backtest. */
  filesAt(sha: string): string[] {
    const out = this.read(['ls-tree', '-r', '--name-only', sha]);
    if (out.status !== 0) return [];
    return out.stdout
      .split('\n')
      .map((line) => normalizePath(unquoteGitPath(line.trim())))
      .filter((line) => line.length > 0);
  }
}

/**
 * Undoes git's C-style path quoting.
 *
 * Unless `core.quotePath` is off, git wraps any path containing a byte outside
 * printable ASCII - or a `"`, a backslash or a control character - in double
 * quotes and escapes those bytes: `deploy/wartości.yaml` is reported as
 * `"deploy/warto\305\233ci.yaml"`. Left as written, that path matches no hard
 * rule and no include pattern, and `git blame` on it fails, so exactly the
 * files whose names carry diacritics fall silently out of the product.
 *
 * The escapes are *bytes*, not code points, so they are collected into a byte
 * buffer and decoded as UTF-8 at the end: a single accented character is two
 * or three separate `\nnn` escapes and decoding them one at a time would
 * produce mojibake rather than the name.
 *
 * A path that is not quoted is returned untouched, which is every ASCII path.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (char !== '\\') {
      for (const byte of Buffer.from(char, 'utf8')) bytes.push(byte);
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) break;
    const octal = /^[0-7]{3}/.exec(body.slice(index + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
      continue;
    }
    const simple = C_ESCAPES[next];
    if (simple !== undefined) {
      bytes.push(simple);
      index += 1;
      continue;
    }
    // An escape git does not produce: keep the character it protected rather
    // than dropping it, so an unknown sequence cannot silently shorten a path.
    for (const byte of Buffer.from(next, 'utf8')) bytes.push(byte);
    index += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The single-character escapes `quote_c_style` emits, by the character that
 *  follows the backslash. */
const C_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  t: 0x09,
  n: 0x0a,
  v: 0x0b,
  f: 0x0c,
  r: 0x0d,
  '"': 0x22,
  '\\': 0x5c,
};

/** ASCII record separator: it cannot appear in a commit subject, so a subject
 *  containing a newline still splits into exactly one record. */
const RECORD = '\u001e';
const LOG_FORMAT = `${RECORD}%H%x09%at%x09%P%x09%s`;

function parseNumstat(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of text.split('\n')) {
    const parsed = parseNumstatLine(line);
    if (parsed) files.push(parsed);
  }
  return files;
}

function parseNumstatLine(line: string): ChangedFile | null {
  if (line.trim().length === 0) return null;
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const [addedRaw, deletedRaw, ...rest] = parts;
  const path = rest.join('\t');
  if (path.length === 0) return null;
  // git prints "-" for a file it will not count lines in.
  const binary = addedRaw === '-' || deletedRaw === '-';
  return {
    path: normalizePath(unquoteGitPath(path)),
    previousPath: null,
    added: binary ? 0 : Number.parseInt(addedRaw ?? '0', 10) || 0,
    deleted: binary ? 0 : Number.parseInt(deletedRaw ?? '0', 10) || 0,
    binary,
  };
}

export function parseLog(text: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (const chunk of text.split(RECORD)) {
    if (chunk.trim().length === 0) continue;
    const newline = chunk.indexOf('\n');
    const header = newline < 0 ? chunk : chunk.slice(0, newline);
    const body = newline < 0 ? '' : chunk.slice(newline + 1);
    const [sha, at, parents, ...subjectParts] = header.split('\t');
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;
    records.push({
      sha,
      timestamp: Number.parseInt(at ?? '0', 10) || 0,
      subject: subjectParts.join('\t'),
      parents: (parents ?? '').split(' ').filter((entry) => entry.length > 0),
      files: parseNumstat(body),
    });
  }
  return records;
}

/** One line of a file and the commit that introduced it. */
export interface BlamedLine {
  sha: string;
  /** Line number in the blamed revision, which is the coordinate a diff's old
   *  side speaks in. */
  line: number;
}

/**
 * Line-to-commit pairs from a `--porcelain` blame.
 *
 * The header line of each blamed line is `<sha> <line in the original>
 * <line in the final file> [<lines in this group>]`, and it is the *final*
 * number - the second one - that names the line in the revision being blamed.
 * Taking the first would silently shift every attribution by however far the
 * line has moved since the commit that introduced it.
 */
export function parseBlamedLines(text: string): BlamedLine[] {
  const lines: BlamedLine[] = [];
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (match?.[1] && match[2]) lines.push({ sha: match[1], line: Number.parseInt(match[2], 10) });
  }
  return lines;
}

/** Introducing commit of every line in a `--porcelain` blame, in order. Header
 *  lines carry the sha; content lines are prefixed with a tab and ignored. */
export function parseBlamePorcelain(text: string): string[] {
  const shas: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{40}) \d+ \d+(?: \d+)?$/.exec(line);
    if (match?.[1]) shas.push(match[1]);
  }
  return shas;
}

/** A hunk of a commit's patch that removed lines, expressed in the coordinates
 *  of the *parent* - which is where blame has to look for them. */
export interface RemovedRange {
  path: string;
  start: number;
  end: number;
}

/**
 * Ranges of removed lines, per file, from a `-U0` patch.
 *
 * Only removals are collected, and that is the SZZ premise: a fix that deletes
 * or rewrites a line is pointing at the line that was wrong. Pure additions
 * point at nothing - there was no earlier line to blame - so counting them
 * would turn the signal into "which files grew", which is churn, measured
 * separately and weighted differently.
 */
export function parseRemovedRanges(patch: string): RemovedRange[] {
  const ranges: RemovedRange[] = [];
  let path: string | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('--- ')) {
      // Unquoted first: git quotes the whole `a/<path>` token, so the `a/`
      // prefix is inside the quotes and cannot be stripped before it.
      const value = unquoteGitPath(line.slice(4).trim());
      // `/dev/null` is a created file: nothing of it existed in the parent.
      path = value === '/dev/null' ? null : normalizePath(value.replace(/^a\//, ''));
      continue;
    }
    if (!line.startsWith('@@') || path === null) continue;
    const match = /^@@+ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (!match) continue;
    const start = Number.parseInt(match[1] ?? '0', 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (count <= 0) continue; // a pure insertion: `-<line>,0`
    ranges.push({ path, start, end: start + count - 1 });
  }
  return ranges;
}
