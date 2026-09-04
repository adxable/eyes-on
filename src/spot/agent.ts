import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { MAX_OUTPUT_BYTES, signalDetail, spawnFailureMessage, spawnFailureOf } from '../core/spawn.js';

/**
 * The single door to a local coding agent.
 *
 * Both stage-2 features that need a model - the fragment ranking's second
 * stage and the drift comparison - go through here, and every property that
 * makes those features safe lives in this file rather than in either caller.
 *
 * **One call, one prompt, on stdin.** A prompt carrying twelve hunks is larger
 * than an argument vector should be, and passing it as an argument would put
 * the change's source into the process table.
 *
 * **The repository picks an agent by name; eyes-on owns the argument vector.**
 * `.eyes-on.yml` is read from the default branch of the repository being
 * assessed (`rules/trusted.ts`), which makes it repository content, and this
 * is the one place that content reaches process execution. Trusting the
 * default branch to decide which paths need a reviewer is not by itself a
 * reason to let it choose what eyes-on runs, and narrowing that choice one
 * dimension at a time did not hold: first the program's path, then its name,
 * then its flags - and the prompt those flags govern is built from the same
 * repository's diff, so `claude -p --dangerously-skip-permissions` would be
 * that repository handing itself an agent with broad permissions and
 * attacker-controlled input.
 *
 * So the choice is closed rather than filtered. `model.agent` names one entry
 * of `AGENT_ARGV` and eyes-on holds the whole argv that name maps to. There is
 * nothing left for a repository to choose: not the path, not the name outside
 * the set, not the flags, and not a dimension nobody has thought of yet.
 * The working directory was such a dimension - a coding agent reads the
 * settings and instruction files of the directory it starts in - and it is
 * closed the same way: `modelOptionsFor` starts the agent in `Paths.agentDir`,
 * a directory eyes-on owns, and never in the clone.
 * `model.command` is honoured only under `model.allow_any_command` in
 * `~/.eyes-on/config.yaml`, which no branch can write; a repository that
 * carries `model.command` without it is refused and the caller falls back to
 * stage one rather than silently running something else.
 *
 * **Nothing here throws.** Every failure is a value the caller reports: a
 * model that is missing, refused, slow or incoherent leaves stage one standing
 * and says which of those happened. A spotlight that failed loudly would be
 * worse than one that says "the model was not reached" over a real ranking.
 */

/** Agent names `model.agent` may carry. */
export const KNOWN_AGENTS: readonly string[] = [
  'claude',
  'codex',
  'copilot',
  'cursor-agent',
  'opencode',
  'pi',
  'rovodev',
];

/**
 * How eyes-on invokes each agent it can invoke: the complete argument vector,
 * held here rather than taken from configuration.
 *
 * Only `claude` is in it, because `claude -p` is the only invocation exercised
 * against a real agent here. The others are names eyes-on recognises and has
 * never run: each reads a prompt differently, and an argv naming a flag nobody
 * has tried would be a diagnostic promising a remedy that does not work. A
 * repository naming one of them is told exactly that, and pointed at the
 * machine-owned escape rather than left with a guess.
 */
export const AGENT_ARGV: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude', '-p'],
};

/** The agent assumed when `.eyes-on.yml` says nothing, and only when it is
 *  actually on PATH. */
export const DEFAULT_AGENT = 'claude';

export const DEFAULT_TIMEOUT_MS = 180_000;

export type ModelOutcome =
  | { state: 'ok'; text: string; command: string[]; elapsed_ms: number }
  | { state: 'skipped'; detail: string }
  | { state: 'refused'; detail: string }
  | { state: 'unavailable'; detail: string }
  | { state: 'failed'; detail: string; command: string[]; elapsed_ms: number };

export interface ModelOptions {
  /** `model.agent` from the trusted `.eyes-on.yml`, or null when the field was
   *  absent and the default applies. An empty string is not the same as an
   *  absent field: it is the repository saying "no model here". */
  agent: string | null;
  /** `model.command` from the trusted `.eyes-on.yml`. Honoured only under
   *  `allowAnyCommand`, and otherwise refused rather than ignored: a repository
   *  that asked for a command must be told eyes-on did not run it. */
  command: readonly string[] | null;
  /** Whether the machine's own config lets a repository name an argv at all. */
  allowAnyCommand: boolean;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves what would be run, without running it. `spotlight` and `drift` both
 * report this before they call anything, so `--no-model` and "no model
 * configured" read differently in the output.
 */
export function resolveModelCommand(options: ModelOptions): { command: string[] } | { refusal: ModelOutcome } {
  // An empty vector names nothing to run, so it is the repository opting out -
  // the same meaning an empty `model.agent` carries - and it means that whether
  // or not the machine allows a vector at all. Refusing it as "a vector from
  // the repository" would describe a state the code is not in, and would give
  // one configuration two readings decided by a setting unrelated to it.
  if (options.command !== null && options.command.length === 0) return optedOut();
  if (options.command !== null && !options.allowAnyCommand) {
    return {
      refusal: {
        state: 'refused',
        detail:
          'model.command in the trusted .eyes-on.yml names an argument vector, and that vector comes from the ' +
          'repository being assessed, so eyes-on will not run it. Use model.agent with one of ' +
          `${KNOWN_AGENTS.join(', ')} and eyes-on supplies the arguments, or set model.allow_any_command: true in ` +
          '~/.eyes-on/config.yaml - the machine\'s own file, which no branch can write - to run the vector as given',
      },
    };
  }
  const resolved = options.allowAnyCommand && options.command !== null
    ? { argv: [...options.command] }
    : argvForAgent(options.agent);
  if ('refusal' in resolved) return resolved;
  const argv = resolved.argv;
  if (argv.length === 0) return optedOut();

  const name = argv[0] as string;
  if (!isExecutable(name, options.env ?? process.env, options.cwd)) {
    return {
      refusal: {
        state: 'unavailable',
        detail: hasPathSeparator(name)
          ? `${name} is not an executable file relative to ${options.cwd ?? process.cwd()}, so no model was reached`
          : `${name} is not on PATH, so no model was reached`,
      },
    };
  }
  return { command: argv };
}

/**
 * The one reading of a repository asking for no model, however it said so.
 *
 * Like every refusal here it says why a model was not reached and stops there.
 * Three commands print these words and only one of them has stages or a
 * ranking, so a shared sentence naming either would describe a state two of
 * them are never in; the consequence belongs to the caller, which knows it.
 */
function optedOut(): { refusal: ModelOutcome } {
  return {
    refusal: {
      state: 'skipped',
      detail: 'the trusted .eyes-on.yml asks for no model, so none was called',
    },
  };
}

/**
 * The argv for a repository's `model.agent`, or the refusal that names why
 * there is not one. An empty name is the repository opting out and comes back
 * as an empty vector, which the caller reports as `skipped` rather than as a
 * failure - opting out is a choice, not a fault.
 */
function argvForAgent(agent: string | null): { argv: string[] } | { refusal: ModelOutcome } {
  if (agent !== null && agent.trim().length === 0) return { argv: [] };
  const name = agent === null ? DEFAULT_AGENT : agent.trim();
  if (!KNOWN_AGENTS.includes(name)) {
    return {
      refusal: {
        state: 'refused',
        detail:
          `model.agent names ${name}, which is not one of the agents eyes-on knows ` +
          `(${KNOWN_AGENTS.join(', ')}); it comes from the repository, so eyes-on will not execute it. Set ` +
          'model.allow_any_command: true in ~/.eyes-on/config.yaml and use model.command to run it anyway',
      },
    };
  }
  const argv = AGENT_ARGV[name];
  if (!argv) {
    return {
      refusal: {
        state: 'refused',
        detail:
          `model.agent names ${name}, which eyes-on recognises but has never invoked, so it holds no argument ` +
          `vector for it and will not guess one (only ${Object.keys(AGENT_ARGV).join(', ')} has been exercised ` +
          'here). Set model.allow_any_command: true in ~/.eyes-on/config.yaml and use model.command to supply the ' +
          'arguments yourself',
      },
    };
  }
  return { argv: [...argv] };
}

/** Runs the agent once with `prompt` on stdin. */
export function askModel(prompt: string, options: ModelOptions): ModelOutcome {
  const resolved = resolveModelCommand(options);
  if ('refusal' in resolved) return resolved.refusal;
  const command = resolved.command;
  const started = process.hrtime.bigint();
  const result = spawnSync(command[0] as string, command.slice(1), {
    input: prompt,
    encoding: 'utf8',
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const elapsed = Math.round(Number(process.hrtime.bigint() - started) / 1e6);

  const failure = spawnFailureOf(result);
  if (failure !== null) {
    return {
      state: 'failed',
      command,
      elapsed_ms: elapsed,
      // An agent that wrote more than eyes-on reads, and one something else
      // killed, are not agents that could not be run - and only absence is
      // worth trying to install.
      detail:
        failure === 'timeout'
          ? `${command[0]} did not answer within ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s`
          : spawnFailureMessage(
              command[0] as string,
              failure,
              failure === 'signalled' ? signalDetail(result) : String(result.error?.message ?? ''),
            ),
    };
  }
  if (result.status !== 0) {
    return {
      state: 'failed',
      command,
      elapsed_ms: elapsed,
      detail: `${command[0]} exited ${result.status ?? -1}: ${firstLine(result.stderr ?? '')}`,
    };
  }
  return { state: 'ok', text: result.stdout ?? '', command, elapsed_ms: elapsed };
}

/**
 * The first JSON object in a model's answer.
 *
 * Agents wrap answers in prose and in fenced blocks however firmly they are
 * asked not to, and a spotlight that discarded an otherwise correct answer over
 * a "Here you go:" would fall back to stage one for a reason that has nothing
 * to do with the model. Braces are counted rather than matched by a regular
 * expression, because the payload contains diff text with braces in it.
 *
 * The prose ahead of the answer can itself hold a balanced brace group - it is
 * quoting code, and the code the spotlight was given is full of braces - so a
 * group that is not JSON moves the scan on to the next opening brace instead of
 * ending it. Giving up on the first one would throw away a correct answer and
 * lose the whole of the second stage for that run.
 */
export function extractJson(text: string): unknown | null {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = balancedEnd(text, start);
    if (end < 0) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
  }
  return null;
}

/** The index of the brace closing the group that opens at `start`, or -1 when
 *  nothing closes it. Strings are skipped, so a brace inside one is text. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim().length > 0);
  return (line ?? 'no output on stderr').trim().slice(0, 300);
}

/** Whether a name is a path rather than something PATH can resolve. */
export function hasPathSeparator(name: string): boolean {
  return /[/\\]/.test(name);
}

/**
 * Whether a command name resolves to something executable, without running it.
 *
 * `cwd` is the directory a relative name is resolved against, and it is the
 * same one `askModel` spawns in. Passing it here rather than reading
 * `process.cwd()` is what keeps the check and the spawn looking at one file:
 * the agent starts in eyes-on's own directory while the command runs from
 * wherever the caller invoked it, so the two would otherwise disagree about
 * what a relative name means.
 */
export function isExecutable(name: string, env: NodeJS.ProcessEnv, cwd?: string): boolean {
  if (hasPathSeparator(name)) {
    return canExecute(isAbsolute(name) ? name : resolve(cwd ?? process.cwd(), name));
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.length > 0 && canExecute(join(dir, name))) return true;
  }
  return false;
}

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
