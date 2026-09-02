import { ForeignStateRootError, Paths, SocketPathTooLongError } from '../core/paths.js';
import { refusalHelp, type GuardVerdict } from '../core/guard.js';
import { EXIT_USAGE, UserFacingError, type Format, type Writers } from './output.js';
import { toplevel } from '../git/git.js';
import { canonicalPath } from '../core/repoid.js';
import type { ParsedArgs } from './args.js';

/** Everything a command handler needs, resolved once by the dispatcher. */
export interface Context {
  args: ParsedArgs;
  paths: Paths;
  format: Format;
  writers: Writers;
  cwd: string;
  env: NodeJS.ProcessEnv;
  guard: GuardVerdict;
}

/**
 * Resolves the state root for a command, turning the refusals `Paths` can raise
 * into the `error:` plus `help:` shape every other failure leaves through.
 * Every entry point that builds a `Paths` from user input goes through here, so
 * a refused root is reported the same way whichever command asked for it.
 */
export function pathsAt(root: string | null, env: NodeJS.ProcessEnv = process.env): Paths {
  try {
    return root ? Paths.withRoot(root, env) : Paths.fromEnv(env);
  } catch (error) {
    if (error instanceof ForeignStateRootError || error instanceof SocketPathTooLongError) {
      throw new UserFacingError(error.message, error.help, EXIT_USAGE);
    }
    throw error;
  }
}

/**
 * Refuses a state-mutating command when this process is running inside a
 * no-mistakes pipeline run (report M24, K16). Read-only commands never call
 * this, which is the whole point: eyes-on stays useful as a source of
 * information inside a run and merely declines to record anything.
 */
export function assertMayMutate(context: Context, commandName: string): void {
  if (!context.guard.insideGate) return;
  throw new UserFacingError(
    `refusing to run "${commandName}" from inside a no-mistakes run: ${context.guard.detail}`,
    refusalHelp(commandName),
    EXIT_USAGE,
  );
}

/** The working clone containing cwd, or a user-facing error explaining that
 *  eyes-on only works inside a git repository. */
export function requireRepo(context: Context): string {
  const top = toplevel(context.cwd);
  if (!top) {
    throw new UserFacingError(`${context.cwd} is not inside a git repository`, [
      'Run eyes-on from a git working clone',
      'Run `eyes-on doctor` to see what eyes-on can and cannot reach from here',
    ]);
  }
  return canonicalPath(top);
}
