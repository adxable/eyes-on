import { mkdirSync } from 'node:fs';
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
 * The working directory handed to the agent is `Paths.agentDir`, never the
 * clone. A coding agent resolves its settings and instruction files from the
 * directory it starts in, so starting it in the checkout would let the branch
 * being assessed configure - through a `.claude/settings.json` and a
 * `CLAUDE.md` it added in the same change - the process eyes-on spawns with
 * that branch's diff as its prompt. That is the same vector as `model.command`
 * wearing another disguise, and it is closed the same way: eyes-on hands the
 * agent an environment eyes-on owns. The prompt is delivered on stdin and
 * carries the whole input, so the fragments and the drift grade are computed
 * from the text eyes-on supplies and from nothing the repository can add.
 */
export function modelOptionsFor(context: Context, config: RepoConfig): ModelOptions | null {
  if (flagBool(context.args, 'no-model')) return null;
  const cwd = context.paths.agentDir;
  mkdirSync(cwd, { recursive: true });
  return {
    agent: config.model.agent,
    command: config.model.command,
    allowAnyCommand: loadConfig(context.paths).model.allow_any_command,
    cwd,
    env: context.env,
  };
}
