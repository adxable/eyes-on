import { normalizePath } from '../core/glob.js';
import { unquoteGitPath } from '../git/reader.js';

/**
 * A unified diff, split into the fragments a human would read.
 *
 * The hunk - not the file and not the line - is the unit the whole ranking is
 * built on, and the research report says why (section 1.3): Meta's spotlight
 * ranks fragments, because a file is too coarse to send someone to and a line
 * carries no context to judge. A hunk with three lines of context either side
 * is the smallest thing that can be read on its own.
 *
 * This parser is deliberately tolerant. Everything it cannot classify is
 * skipped rather than raised: a diff containing a binary file, a mode change or
 * a submodule pointer is an ordinary diff, and refusing it would make the
 * emergency path - `--no-model`, the one that must work when everything else
 * does not - fail on exactly the changes most worth ranking.
 */

export interface Hunk {
  /** Path on the new side, or the old path for a deleted file. */
  path: string;
  /** True when the file is gone on the new side. */
  deleted: boolean;
  /** True when the file did not exist on the old side. */
  created: boolean;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The line a reader should be sent to: the first added line where there is
   *  one, else the start of the hunk on the side that still exists. */
  anchor: number;
  added: number;
  removed: number;
  /** The hunk exactly as git wrote it, header line included. */
  text: string;
}

/** Lines a hunk changed. The size term of the ranking, and the only thing in
 *  it that a hunk can inflate on its own - which is why the formula multiplies
 *  it by a file risk the change cannot influence. */
export function hunkSize(hunk: Hunk): number {
  return hunk.added + hunk.removed;
}

/** The old-side range a hunk covers, or null for a pure insertion, which has
 *  no old-side line to blame. */
export function oldRange(hunk: Hunk): { start: number; end: number } | null {
  if (hunk.oldCount <= 0) return null;
  return { start: hunk.oldStart, end: hunk.oldStart + hunk.oldCount - 1 };
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let current: Hunk | null = null;
  const body: string[] = [];

  const flush = (): void => {
    if (!current) return;
    current.text = body.join('\n');
    current.anchor = anchorOf(current, body);
    hunks.push(current);
    current = null;
    body.length = 0;
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      oldPath = null;
      newPath = null;
      continue;
    }
    if (line.startsWith('--- ')) {
      flush();
      oldPath = sidePath(line.slice(4), 'a/');
      continue;
    }
    if (line.startsWith('+++ ')) {
      flush();
      newPath = sidePath(line.slice(4), 'b/');
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      flush();
      const path = newPath ?? oldPath;
      // A hunk header before either side's path is not something git emits;
      // skipping it keeps a malformed patch from inventing a fragment with no
      // file to send anyone to.
      if (path === null) continue;
      current = {
        path,
        deleted: newPath === null,
        created: oldPath === null,
        oldStart: Number.parseInt(header[1] ?? '0', 10),
        oldCount: header[2] === undefined ? 1 : Number.parseInt(header[2], 10),
        newStart: Number.parseInt(header[3] ?? '0', 10),
        newCount: header[4] === undefined ? 1 : Number.parseInt(header[4], 10),
        anchor: 0,
        added: 0,
        removed: 0,
        text: '',
      };
      body.push(line);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) current.added += 1;
    else if (line.startsWith('-')) current.removed += 1;
    else if (!line.startsWith(' ') && line.length > 0 && !line.startsWith('\\')) {
      // Anything else at hunk level ends it: `diff --git` is handled above, and
      // a stray line is the start of the next file's header in a patch git
      // wrote differently than expected.
      flush();
      continue;
    }
    body.push(line);
  }
  flush();
  return hunks;
}

/**
 * Where a reader is sent inside the hunk.
 *
 * The first added line, because that is the change; a hunk that only removes
 * lines has no new-side line of its own, so it points at the position the
 * removal left behind. Deleted files are reported in old-side coordinates,
 * which is the only numbering their content still has.
 */
function anchorOf(hunk: Hunk, body: readonly string[]): number {
  if (hunk.deleted) return hunk.oldStart;
  let line = hunk.newStart;
  for (const entry of body.slice(1)) {
    if (entry.startsWith('+')) return line;
    if (entry.startsWith('-') || entry.startsWith('\\')) continue;
    line += 1;
  }
  return hunk.newStart;
}

/** `a/src/x.ts` or `"b/deploy/warto\305\233ci.yaml"` to `src/x.ts`, and
 *  `/dev/null` to null. Unquoting comes first: git quotes the whole token, so
 *  the `a/` prefix is inside the quotes and cannot be stripped before it. */
function sidePath(raw: string, prefix: string): string | null {
  const value = unquoteGitPath(raw.trim().replace(/\t.*$/, ''));
  if (value === '/dev/null') return null;
  return normalizePath(value.startsWith(prefix) ? value.slice(prefix.length) : value);
}
