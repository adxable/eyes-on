import { Paths } from '../core/paths.js';
import { classify } from '../core/guard.js';
import { parseArgs, parseArgsLenient, flagString, flagBool, resolveFormat, type ParsedArgs } from './args.js';
import {
  emitError,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  processWriters,
  UserFacingError,
  type Format,
  type Writers,
} from './output.js';
import { COMMANDS, findCommand, implementedCommands, plannedCommands } from './commands.js';
import type { Context } from './context.js';
import { initCommand } from './init.js';
import { doctorCommand } from './doctor.js';
import { statusCommand } from './status.js';
import { daemonCommand } from './daemon-cmd.js';
import { axiCommand } from './axi.js';
import { stubCommand } from './stubs.js';
import { version, PRODUCT_NAME } from '../core/version.js';

/**
 * The dispatcher.
 *
 * Three rules hold for every command and are enforced here rather than in each
 * handler, so a new command cannot forget them:
 *
 *   - the output format is resolved once (TOON under `axi`, Markdown for the
 *     human surface), so `--format` behaves identically everywhere;
 *   - failures leave through one path and are always rendered as `error:` plus
 *     `help:` with exit 1, or exit 2 when the caller used the CLI wrongly;
 *   - the recursion verdict is computed once, before any handler runs, so a
 *     command cannot accidentally mutate state from inside a no-mistakes run.
 *
 * With no subcommand, eyes-on prints the current state of this repository
 * rather than a usage screen (report M17). At stage 0 there is no assessment to
 * show yet and it says so.
 */

type Handler = (context: Context) => Promise<number> | number;

// A Map, not an object literal: `eyes-on constructor` must reach the
// unknown-command path and be reported as `error:` plus `help:`, not resolve
// `Object.prototype.constructor` and hand the dispatcher something that is not
// a handler.
const HANDLERS = new Map<string, Handler>([
  ['init', initCommand],
  ['doctor', doctorCommand],
  ['status', statusCommand],
  ['daemon', daemonCommand],
  ['axi', axiCommand],
]);

/** Commands whose machine payload is the primary output, so TOON is the default. */
const TOON_FIRST = new Set(['axi']);

export async function run(argv: readonly string[], writers: Writers = processWriters): Promise<number> {
  // Resolved before anything can throw. `parseArgs` and `resolveFormat` both
  // reject bad input, and an error rendered with the wrong format would land on
  // stderr and leave an agent under `axi` with exit 2 and empty stdout.
  let format: Format = initialFormat(argv);
  try {
    const args = parseArgs(argv);
    const commandName = args.positional[0] ?? '';

    if (flagBool(args, 'version') || commandName === 'version') {
      writers.out(`${PRODUCT_NAME} ${version()}\n`);
      return EXIT_OK;
    }
    if (commandName === 'help' || (flagBool(args, 'help') && commandName === '')) {
      writers.out(helpText());
      return EXIT_OK;
    }

    format = resolveFormat(args, TOON_FIRST.has(commandName) ? 'toon' : 'md');
    const context = buildContext(args, format, writers);

    if (commandName === '') {
      // No subcommand: show where this repository stands, not a usage wall.
      return await statusCommand(context);
    }

    if (flagBool(args, 'help')) {
      const spec = findCommand(commandName);
      if (spec) {
        writers.out(`${spec.usage}\n\n${spec.summary}\n`);
        return EXIT_OK;
      }
    }

    const handler = HANDLERS.get(commandName);
    if (handler) {
      return await handler(context);
    }

    const spec = findCommand(commandName);
    if (spec) {
      return stubCommand(context, spec);
    }

    throw new UserFacingError(
      `unknown command ${commandName}`,
      [`Known commands: ${COMMANDS.map((entry) => entry.name).join(', ')}`, 'Run `eyes-on help` for the full surface'],
      EXIT_USAGE,
    );
  } catch (error) {
    if (error instanceof UserFacingError) {
      emitError(writers, format, error.message, error.help);
      return error.code;
    }
    // An unexpected failure is still reported in the contract's shape: an agent
    // parsing stdout must never have to cope with a raw stack trace.
    emitError(writers, format, (error as Error).message ?? 'unexpected error', [
      'This is an eyes-on bug. Run `eyes-on doctor` and include its output when reporting it',
    ]);
    return EXIT_ERROR;
  }
}

/**
 * Best-effort output format for a command line that may not parse. Never
 * throws: an unusable `--format` falls back to the command's default, and the
 * strict parse reports the failure a moment later in the right shape.
 */
function initialFormat(argv: readonly string[]): Format {
  const args = parseArgsLenient(argv);
  const fallback: Format = TOON_FIRST.has(args.positional[0] ?? '') ? 'toon' : 'md';
  try {
    return resolveFormat(args, fallback);
  } catch {
    return fallback;
  }
}

function buildContext(args: ParsedArgs, format: Format, writers: Writers): Context {
  const root = flagString(args, 'root');
  const paths = root ? Paths.withRoot(root) : Paths.fromEnv();
  const cwd = process.cwd();
  return { args, paths, format, writers, cwd, env: process.env, guard: classify({ env: process.env, cwd }) };
}

function helpText(): string {
  const lines = [
    `${PRODUCT_NAME} ${version()} - what does a human actually have to read in this change?`,
    '',
    'Available now:',
  ];
  for (const command of implementedCommands()) {
    lines.push(`  ${command.usage}`);
  }
  lines.push('', 'Planned (these report the stage that owns them and exit 1):');
  for (const command of plannedCommands()) {
    lines.push(`  ${command.usage}  [stage ${command.stage}]`);
  }
  lines.push(
    '',
    'Output: TOON on stdout under `axi`, Markdown elsewhere; override with --format toon|json|md.',
    'Exit codes: 0 success or no-op, 1 error, 2 usage error.',
    '',
  );
  return lines.join('\n');
}
