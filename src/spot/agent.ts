import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';

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
 * **The command is allow-listed by name.** `model.command` is read from the
 * default branch of the repository being assessed (`rules/trusted.ts`), which
 * makes it repository content - and this is the one config field eyes-on
 * *executes*. Trusting the default branch is right for deciding which paths
 * need a reviewer; it is not by itself a reason to run an arbitrary program
 * from a repository somebody cloned. So the executable's name must be one of
 * the agents this product knows, unless the machine's own configuration -
 * `~/.eyes-on/config.yaml`, which no branch can write - says otherwise.
 *
 * **Nothing here throws.** Every failure is a value the caller reports: a
 * model that is missing, refused, slow or incoherent leaves stage one standing
 * and says which of those happened. A spotlight that failed loudly would be
 * worse than one that says "the model was not reached" over a real ranking.
 */

/** Agents whose name may appear in a repository's `model.command`. */
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
 * The default when `.eyes-on.yml` says nothing about a model.
 *
 * Only `claude` is defaulted to, and only when it is actually on PATH. Other
 * agents are accepted from configuration but not guessed at: each reads a
 * prompt differently, and a default that names a flag nobody here has run would
 * be a diagnostic promising a remedy that does not work.
 */
export const DEFAULT_MODEL_COMMAND: readonly string[] = ['claude', '-p'];

export const DEFAULT_TIMEOUT_MS = 180_000;

export type ModelOutcome =
  | { state: 'ok'; text: string; command: string[]; elapsed_ms: number }
  | { state: 'skipped'; detail: string }
  | { state: 'refused'; detail: string }
  | { state: 'unavailable'; detail: string }
  | { state: 'failed'; detail: string; command: string[]; elapsed_ms: number };

export interface ModelOptions {
  /** `model.command` from the trusted `.eyes-on.yml`, or null when the field
   *  was absent and the default applies. An empty array is not the same as an
   *  absent field: it is the repository saying "no model here". */
  command: readonly string[] | null;
  /** Whether the machine's own config lifts the name allow-list. */
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
  const configured = options.command;
  if (configured !== null && configured.length === 0) {
    return {
      refusal: {
        state: 'skipped',
        detail: 'model.command in the trusted .eyes-on.yml is empty, which is how a repository asks for stage one only',
      },
    };
  }
  const command = configured !== null && configured.length > 0 ? [...configured] : [...DEFAULT_MODEL_COMMAND];
  const name = command[0] as string;

  if (!options.allowAnyCommand && !KNOWN_AGENTS.includes(basename(name))) {
    return {
      refusal: {
        state: 'refused',
        detail:
          `model.command names ${name}, which is not one of the agents eyes-on knows (${KNOWN_AGENTS.join(', ')}); ` +
          'it comes from the repository, so eyes-on will not execute it. Set model.allow_any_command: true in ~/.eyes-on/config.yaml to lift this',
      },
    };
  }
  if (!isExecutable(name, options.env ?? process.env)) {
    return {
      refusal: {
        state: 'unavailable',
        detail: `${name} is not on PATH, so the second stage could not run; the ranking below is stage one`,
      },
    };
  }
  return { command };
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
    maxBuffer: 32 * 1024 * 1024,
  });
  const elapsed = Math.round(Number(process.hrtime.bigint() - started) / 1e6);

  if (result.error) {
    const timedOut = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
    return {
      state: 'failed',
      command,
      elapsed_ms: elapsed,
      detail: timedOut
        ? `${command[0]} did not answer within ${Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s`
        : `${command[0]} could not be run: ${result.error.message}`,
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
 */
export function extractJson(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
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
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((entry) => entry.trim().length > 0);
  return (line ?? 'no output on stderr').trim().slice(0, 300);
}

/** Whether a command name resolves to something executable, without running it. */
export function isExecutable(name: string, env: NodeJS.ProcessEnv): boolean {
  if (name.includes('/')) {
    return canExecute(isAbsolute(name) ? name : join(process.cwd(), name));
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
