/**
 * The bridge to no-mistakes: a `review.path_instructions` block.
 *
 * This is a bridge and not a dependency, and the distinction is the whole
 * design (report section 5). eyes-on emits text. It does not read
 * `.no-mistakes.yaml`, does not write it, and does not require no-mistakes to
 * be installed for anything here to work. What the user does with the block is
 * their business.
 *
 * The two caps are no-mistakes', copied deliberately rather than approximated,
 * because a block that exceeds them is rejected when that repository's config
 * is parsed - before a run starts - so an over-budget export would hand someone
 * a file that breaks their pipeline. The constants and the accounting below
 * mirror `internal/config/config.go` in the no-mistakes clone (grep for
 * `ReviewPathInstructionsBytes`; the clone's line numbers are from commit
 * a68298e and move).
 *
 * If those constants ever change upstream, this export becomes conservative
 * rather than wrong: it is an upper bound on the section the review prompt
 * assembles, and `eyes-on export-path-instructions` states the number it
 * computed so a mismatch is visible instead of silent.
 */

export const MAX_ENTRIES = 32;
export const MAX_BYTES = 16384;

const HEADING =
  'Repository review instructions for the changed paths (trusted, from the default branch). Each block below applies only to the files listed under its path, and adds to the requirements above:';
const PATH_LABEL = 'path: ';
const FILES_LABEL = 'matched files: ';
const RULES_LABEL = 'instructions:';
/** Byte allowance no-mistakes charges every entry for its matched-file list,
 *  whatever the real diff turns out to be. */
const MAX_FILES_BYTES = 192;

export interface PathInstruction {
  path: string;
  instructions: string;
}

/** The upper bound on the review-prompt section these entries can produce. */
export function instructionBytes(entries: readonly PathInstruction[]): number {
  if (entries.length === 0) return 0;
  let total = '\n\n'.length + byteLength(HEADING) + 1;
  entries.forEach((entry, index) => {
    if (index > 0) total += '\n\n'.length;
    total += byteLength(PATH_LABEL) + byteLength(entry.path.trim()) + 1;
    total += byteLength(FILES_LABEL) + MAX_FILES_BYTES + 1;
    total += byteLength(RULES_LABEL) + 1;
    total += byteLength(entry.instructions.trim());
  });
  return total;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export interface FitResult<T extends PathInstruction = PathInstruction> {
  entries: T[];
  /** Entries that did not fit, in the order they were dropped. Reported rather
   *  than silently truncated: a cap nobody is told about reads as coverage. */
  dropped: T[];
  bytes: number;
  reason: 'fits' | 'entry-cap' | 'byte-cap';
}

/**
 * Trims a prioritised list to both caps.
 *
 * The input must already be in priority order - hard rules first, then the
 * paths history says are riskiest - because what falls off the end is decided
 * here by position and nothing else.
 *
 * What survives is **not** a prefix of the input. The entry cap stops the list,
 * but a candidate too large for the remaining byte budget is skipped while
 * later, smaller ones still fit - so nothing downstream may infer where an
 * entry came from by counting positions. The candidate type is carried through
 * unchanged for exactly that reason: whatever an entry knows about itself on
 * the way in is still attached to it on the way out.
 */
export function fitWithinCaps<T extends PathInstruction>(candidates: readonly T[]): FitResult<T> {
  const entries: T[] = [];
  const dropped: T[] = [];
  let reason: FitResult['reason'] = 'fits';

  for (const candidate of candidates) {
    if (entries.length >= MAX_ENTRIES) {
      dropped.push(candidate);
      reason = 'entry-cap';
      continue;
    }
    const next = [...entries, candidate];
    if (instructionBytes(next) > MAX_BYTES) {
      dropped.push(candidate);
      if (reason === 'fits') reason = 'byte-cap';
      continue;
    }
    entries.push(candidate);
  }

  return { entries, dropped, bytes: instructionBytes(entries), reason };
}

/**
 * Renders the block.
 *
 * Instructions are emitted as a YAML block scalar so a multi-line rule needs no
 * escaping, and paths are quoted because a glob starting with `*` is not a
 * valid bare scalar.
 */
export function renderPathInstructions(entries: readonly PathInstruction[]): string {
  if (entries.length === 0) {
    return 'review:\n  path_instructions: []\n';
  }
  const lines: string[] = ['review:', '  path_instructions:'];
  for (const entry of entries) {
    lines.push(`    - path: ${JSON.stringify(entry.path)}`);
    lines.push('      instructions: |');
    for (const line of entry.instructions.trim().split('\n')) {
      lines.push(`        ${line}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
