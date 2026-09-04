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

/**
 * A flag value read as a whole number, or null when the token is not one.
 *
 * `Number.parseInt` is too forgiving to validate with: it reads `42abc` as 42,
 * `1e9` as 1, and a twenty-digit argument as `1e20`, which is finite and
 * positive and therefore passes every check short of `Number.isSafeInteger`. A
 * `--pr` like that used to survive all the way to the gh operation builder,
 * which refuses it as a vector eyes-on itself could not have written - and a
 * user's typo was reported as a defect in eyes-on.
 *
 * So the whole token is read, once, here where flags are read. **Every numeric
 * flag goes through this**, because two spellings of one mistake getting two
 * answers is the defect this exists to prevent: `--n abc` was a usage error
 * while `--n 42abc` was silently read as 42 and then clamped, and the payload
 * reported a number nobody asked for.
 *
 * What a caller does with a number *out of range* is the caller's, and the two
 * kinds differ on purpose: `--pr` is a contract and a number outside it is
 * refused, while `--n` and `--lines` are preferences and are clamped into their
 * range. Null here means only "that was not a number".
 */
export function flagCount(args: ParsedArgs, name: string): number | null {
  const raw = flagString(args, name);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) ? value : null;
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
