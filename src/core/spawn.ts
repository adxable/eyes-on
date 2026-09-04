/**
 * One output ceiling, and one reading of why a subprocess did not give eyes-on
 * an exit status, shared by every process eyes-on spawns.
 *
 * `spawnSync` has exactly one shape for success - `status` is a number - and
 * several distinct failures it reports almost identically. Four of them set
 * `error` and leave `status` null:
 *
 *   - `ENOENT`: the program is not on PATH;
 *   - `ENOBUFS`: the program ran and wrote more than `maxBuffer` bytes, whose
 *     default is 1 MiB. A branch diff or a busy pull request's comments cross
 *     that on their own;
 *   - `ETIMEDOUT`: the program ran and was killed for taking too long;
 *   - anything else the runtime could not classify.
 *
 * A fifth leaves `error` **unset** and `status` null with `signal` set: the
 * child was killed from outside - an interrupt, a supervisor, the out-of-memory
 * killer. A caller that reads only `error` sees a success-shaped result with no
 * status and invents one, which is how a killed subprocess came to be reported
 * as a defect in eyes-on.
 *
 * Collapsing any of these into "could not be executed" is the failure carried
 * rule 1 forbids: the diagnostic named a state the machine was not in and
 * proposed a remedy - install git - that cannot work when git is installed and
 * ran. So the classification lives here, once, over the whole `spawnSync`
 * result rather than over its error alone, and every spawner takes both its
 * sentence and its help from it rather than writing its own.
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
  /** The program ran and was killed from outside - an interrupt, a supervisor,
   *  the out-of-memory killer. `spawnSync` reports this with no error at all,
   *  so only a classifier that reads the whole result can see it. */
  | 'signalled'
  /** It could not be run to completion for some other reason. */
  | 'unknown';

/** Which of the states a `spawnSync` error describes. */
export function spawnFailureKindOf(error: unknown): SpawnFailureKind {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  if (code === 'ENOENT') return 'missing';
  if (code === 'ENOBUFS') return 'output-too-large';
  if (code === 'ETIMEDOUT') return 'timeout';
  return 'unknown';
}

/** The shape of a `spawnSync` result, narrowed to what deciding this needs. */
export interface SpawnResultShape {
  error?: Error | undefined;
  status: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Why this invocation produced no exit status, or null when it produced one.
 *
 * This is the exhaustive reading, and it is exhaustive on purpose: every branch
 * `spawnSync` can return either yields a status a caller may act on, or a kind
 * that names what happened. A caller that gets null here has a real number in
 * `result.status` and needs no sentinel for the absence of one.
 */
export function spawnFailureOf(result: SpawnResultShape): SpawnFailureKind | null {
  if (result.error) return spawnFailureKindOf(result.error);
  if (result.status !== null) return null;
  return result.signal !== null ? 'signalled' : 'unknown';
}

/** The signal a killed child died of, for the sentence that names it. */
export function signalDetail(result: SpawnResultShape): string {
  return result.signal ?? 'an unknown signal';
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
    case 'signalled':
      return `${program} ran and was killed by ${detail} before it could answer`;
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
    case 'signalled':
      return [
        ranAndIsInstalled,
        `Something outside eyes-on stopped ${program} - an interrupt, a supervisor, or the out-of-memory killer - so run the command again`,
        ...(remedy === null ? [] : [remedy]),
        doctor,
      ];
    default:
      return [`${program} is reachable but could not be run to completion`, doctor];
  }
}

function mib(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
