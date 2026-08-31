import type { Context } from './context.js';
import { statusCommand } from './status.js';
import { EXIT_USAGE, UserFacingError } from './output.js';
import { findCommand } from './commands.js';
import { stubCommand } from './stubs.js';

/**
 * The AXI subtree: the agent-facing entry point (report M15).
 *
 * It differs from the human commands in exactly one way - the default output
 * format is TOON rather than Markdown. Everything else, including the exit
 * codes and the `error:`/`help:` shape, is identical, because the report's
 * contract applies to the whole CLI and not just to this subtree.
 */
export async function axiCommand(context: Context): Promise<number> {
  const subcommand = context.args.positional[1] ?? 'status';
  switch (subcommand) {
    case 'status':
      return statusCommand(context);
    case 'check':
    case 'respond':
    case 'logs':
    case 'abort': {
      const spec = findCommand(subcommand) ?? {
        name: `axi ${subcommand}`,
        usage: `eyes-on axi ${subcommand}`,
        summary: 'Drive an assessment run from an agent.',
        stage: 2 as const,
        mutating: true,
        implemented: false,
      };
      return stubCommand(context, spec);
    }
    default:
      throw new UserFacingError(
        `unknown axi subcommand ${subcommand}`,
        ['Use one of: status, check, respond, logs, abort'],
        EXIT_USAGE,
      );
  }
}
