import { flagBool } from './args.js';
import type { Context } from './context.js';
import { loadConfig } from '../core/config.js';
import type { RepoConfig } from '../risk/repoconfig.js';
import type { ModelOptions } from '../spot/agent.js';

/**
 * How the three model-using commands decide whether to call one, in one place.
 *
 * `--no-model` returns null, and null is what every caller checks before it
 * builds a prompt. That is the whole of the emergency path: there is no branch
 * anywhere that can reach `askModel` with the flag set, so "`--no-model` never
 * calls a model" is a property of the shape of the code rather than of three
 * separate `if`s staying in agreement.
 *
 * The working directory handed to the agent is the clone. It has to be
 * somewhere - an agent resolves its own configuration relative to it - and the
 * clone is the one directory that is certainly the right repository. eyes-on's
 * own prohibitions are unaffected: nothing here writes, and the agent is given
 * a prompt on stdin and no instruction to touch anything.
 */
export function modelOptionsFor(
  context: Context,
  config: RepoConfig,
  clonePath: string,
): ModelOptions | null {
  if (flagBool(context.args, 'no-model')) return null;
  return {
    agent: config.model.agent,
    command: config.model.command,
    allowAnyCommand: loadConfig(context.paths).model.allow_any_command,
    cwd: clonePath,
    env: context.env,
  };
}
