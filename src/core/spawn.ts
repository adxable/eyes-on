/**
 * One output ceiling, and one reading of why a subprocess never produced a
 * status, shared by every process eyes-on spawns.
 *
 * `spawnSync` reports three different states of the machine identically -
 * `result.error` set and `status` null - and only one of them is fixed by
 * installing anything:
 *
 *   - `ENOENT`: the program is not on PATH;
 *   - `ENOBUFS`: the program ran and wrote more than `maxBuffer` bytes, whose
 *     default is 1 MiB. A branch diff or a busy pull request's comments cross
 *     that on their own;
 *   - `ETIMEDOUT`: the program ran and was killed for taking too long.
 *
 * Collapsing them into "could not be executed" is the failure carried rule 1
 * forbids: the diagnostic named a state the machine was not in and proposed a
 * remedy - install git - that cannot work when git is installed and ran. So the
 * classification lives here, once, and every spawner takes both its sentence
 * and its help from it rather than writing its own.
 */

/**
 * The ceiling every eyes-on subprocess reads under.
 *
 * Deliberately far above the reads this product makes: a whole-branch patch is
 * the largest of them and the branch that prompted this was 0.5 MiB, while a
 * capped model prompt is 40 KB. The number exists so an enormous repository
 * fails as a size condition it can be told about rather than by exhausting
 * memory, not to be a limit anyone meets in practice.
 */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export type SpawnFailureKind =
  /** The program is not on PATH. This one is fixed by installing it. */
  | 'missing'
  /** The program ran and wrote more than `MAX_OUTPUT_BYTES`. */
  | 'output-too-large'
  /** The program ran and was killed for exceeding its timeout. */
  | 'timeout'
  /** It could not be run to completion for some other reason. */
  | 'unknown';

/** Which of the four states a `spawnSync` error describes. */
export function spawnFailureKindOf(error: unknown): SpawnFailureKind {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  if (code === 'ENOENT') return 'missing';
  if (code === 'ENOBUFS') return 'output-too-large';
  if (code === 'ETIMEDOUT') return 'timeout';
  return 'unknown';
}

/**
 * The sentence for a spawn failure. Each names the state the code actually
 * recognises, and the three that are not absence say so in the sentence itself,
 * because the message travels further than the help does.
 */
export function spawnFailureMessage(program: string, kind: SpawnFailureKind, detail: string): string {
  switch (kind) {
    case 'missing':
      return `${program} could not be executed: ${detail}`;
    case 'output-too-large':
      return `${program} ran and produced more than ${mib(MAX_OUTPUT_BYTES)} of output, which is more than eyes-on reads in one invocation`;
    case 'timeout':
      return `${program} ran and was stopped for taking too long to answer`;
    default:
      return `${program} could not be run to completion: ${detail}`;
  }
}

/**
 * What to do about it. `remedy` is the one line only the caller knows - a
 * narrower range for git, say - and it is optional on purpose: where nothing
 * the caller can offer would actually work, the weaker help is the honest one.
 */
export function spawnFailureHelp(
  program: string,
  kind: SpawnFailureKind,
  remedy: string | null = null,
): string[] {
  const doctor = 'Run `eyes-on doctor` to see what eyes-on can and cannot reach from here';
  const ranAndIsInstalled = `${program} is installed and ran, so nothing needs installing`;
  switch (kind) {
    case 'missing':
      return [`Install ${program} and make sure it is on PATH`, doctor];
    case 'output-too-large':
      return [ranAndIsInstalled, ...(remedy === null ? [] : [remedy]), doctor];
    case 'timeout':
      return [ranAndIsInstalled, ...(remedy === null ? [] : [remedy]), doctor];
    default:
      return [`${program} is reachable but could not be run to completion`, doctor];
  }
}

function mib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
