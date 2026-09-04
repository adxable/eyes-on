import type { Context } from './context.js';
import { statusCommand } from './status.js';
import { checkCommand } from './check.js';
import { respondCommand } from './respond.js';
import { logsCommand } from './logs.js';
import { EXIT_USAGE, UserFacingError } from './output.js';

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
      // The same assessment the human command runs; only the default output
      // format differs, and the dispatcher has already resolved that.
      return checkCommand(context);
    case 'respond':
      return respondCommand(context);
    case 'logs':
      return logsCommand(context);
    case 'abort':
      // Not a stub, and not "coming in a later stage": eyes-on genuinely has
      // nothing to abort. A check runs to completion inside one process, and
      // the only thing that waits is a parked gate, which is released by
      // answering it. Saying so is more useful than a not-implemented notice
      // that would still be there after stage 3, describing a command nobody
      // ever needs.
      throw new UserFacingError(
        'eyes-on has no in-flight run to abort',
        [
          'A check is synchronous: when the command returns, the assessment is finished or it failed',
          'A run parked as `must_read` is released by answering it: `eyes-on axi respond --action read`, or `--action waive --reason "..."`',
          'To stop the daemon, use `eyes-on daemon stop`',
        ],
        EXIT_USAGE,
      );
    default:
      throw new UserFacingError(
        `unknown axi subcommand ${subcommand}`,
        ['Use one of: status, check, respond, logs, abort'],
        EXIT_USAGE,
      );
  }
}
