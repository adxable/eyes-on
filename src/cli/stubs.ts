import type { Context } from './context.js';
import { assertMayMutate } from './context.js';
import { EXIT_ERROR, UserFacingError } from './output.js';
import { implementedCommands, type CommandSpec } from './commands.js';

/**
 * Commands that are named but not built yet.
 *
 * The report is explicit that the risk-computing commands belong to stage 1 and
 * later. They exist here so the surface is stable and the skill can describe
 * the whole product - and they fail loudly, naming the stage that owns them.
 *
 * A stub that returned a plausible-looking empty result would be worse than no
 * command at all: the agent calling it would report "no risk found" for a
 * change nobody assessed. Exit 1 with `error:` and `help:` is the honest shape.
 *
 * The recursion guard runs *before* the not-implemented message for mutating
 * commands, so `NO_MISTAKES_GATE=1 eyes-on check` refuses as a gate refusal
 * (exit 2) rather than reporting a missing feature. The refusal is the
 * behaviour under test; it must not depend on the command being finished.
 */
export function stubCommand(context: Context, spec: CommandSpec): number {
  if (spec.mutating) {
    assertMayMutate(context, spec.name);
  }
  throw new UserFacingError(
    `eyes-on ${spec.name} is not implemented yet: it is delivered in stage ${spec.stage}`,
    [
      `Planned behaviour: ${spec.summary}`,
      `Usage once it lands: ${spec.usage}`,
      // Derived from the command table rather than written out, so this line
      // cannot go on naming stage 0's surface after stage 1 has landed.
      `Delivered so far: ${implementedCommands().map((command) => command.name).join(', ')}`,
    ],
    EXIT_ERROR,
  );
}
