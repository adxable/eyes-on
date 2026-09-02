import { EXIT_USAGE, UserFacingError, type Format } from './output.js';

/**
 * Argument parsing. Deliberately hand-written and deliberately small: the CLI
 * surface is a fixed table (commands.ts), and a parser generator would be a
 * dependency bought to solve a problem this product does not have.
 */

export interface ParsedArgs {
  /** Command and any subcommand, in order. */
  positional: string[];
  flags: Map<string, string | boolean>;
}

/** Flags that take a value; everything else is boolean. */
const VALUE_FLAGS = new Set([
  'format',
  'root',
  'base',
  'head',
  'intent',
  'pr',
  'n',
  'split',
  'window',
  'since',
  // Stage 1.
  'default-branch',
  'horizon',
  'min-risk',
  'top',
  // Stage 2.
  'action',
  'reason',
  'by',
  'check-id',
  'lines',
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  return scan(argv, true);
}

/**
 * The same scan, but a value flag with no value is taken as a bare boolean
 * instead of an error. Used to work out how a failure should be *rendered*
 * before the strict parse decides whether there is one: an agent running
 * `eyes-on axi status --format` must still get its error as TOON on stdout.
 */
export function parseArgsLenient(argv: readonly string[]): ParsedArgs {
  return scan(argv, false);
}

function scan(argv: readonly string[], strict: boolean): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    const withoutDashes = token.replace(/^--?/, '');
    const equals = withoutDashes.indexOf('=');
    if (equals >= 0) {
      flags.set(withoutDashes.slice(0, equals), withoutDashes.slice(equals + 1));
      continue;
    }
    if (VALUE_FLAGS.has(withoutDashes)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        if (strict) {
          throw new UserFacingError(`flag --${withoutDashes} needs a value`, [
            `Pass a value, for example --${withoutDashes} <value>`,
          ], EXIT_USAGE);
        }
        flags.set(withoutDashes, true);
        continue;
      }
      flags.set(withoutDashes, value);
      index += 1;
      continue;
    }
    flags.set(withoutDashes, true);
  }
  return { positional, flags };
}

export function flagString(args: ParsedArgs, name: string): string | null {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : null;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}

const FORMATS: readonly Format[] = ['toon', 'json', 'md'];

/** Resolves --format, falling back to the caller's default for this command. */
export function resolveFormat(args: ParsedArgs, fallback: Format): Format {
  const requested = flagString(args, 'format');
  if (requested === null) {
    return flagBool(args, 'json') ? 'json' : fallback;
  }
  if (!FORMATS.includes(requested as Format)) {
    throw new UserFacingError(
      `unknown output format ${requested}`,
      [`Use one of: ${FORMATS.join(', ')}`],
      EXIT_USAGE,
    );
  }
  return requested as Format;
}
