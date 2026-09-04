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
  if (NUMERIC_FLAGS.has(name)) {
    throw new Error(
      `--${name} is a numeric flag: read it with flagCount. Handing back the raw token invites Number.parseInt, ` +
        'which reads "1e9" as 1 and "42abc" as 42',
    );
  }
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : null;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === 'true';
}

/**
 * Every flag whose value is a number.
 *
 * This list is what makes `flagCount` the *only* way to read one: `flagString`
 * refuses a name that appears here, so a caller cannot get the raw token and
 * reach for `Number.parseInt` - which reads `1e9` as 1 and `42abc` as 42, and
 * which four review rounds found in four different commands, each time one
 * command over from the one that had just been fixed. A declaration a new flag
 * has to join is the difference between an invariant and a sweep.
 */
export const NUMERIC_FLAGS: ReadonlySet<string> = new Set(['pr', 'n', 'lines', 'top', 'min-risk', 'horizon']);

/**
 * What a numeric flag accepts, and what to say when it does not.
 *
 * `min`/`max` are optional because the two kinds of numeric flag answer "out of
 * range" differently on purpose. A **contract** - `--pr`, `--top`, `--min-risk`,
 * `--horizon` - names them and a value outside is refused. A **preference** -
 * `--n`, `--lines` - names neither and the caller clamps, because the report's
 * three-to-five range and a log tail are things eyes-on may decide for you.
 */
export interface CountFlag {
  /** Completes "--<flag> <value> is not ...". */
  what: string;
  help: readonly string[];
  min?: number;
  max?: number;
}

/**
 * A numeric flag's value, or null when the caller did not name it.
 *
 * The whole token is read: digits only, and a whole number this program can
 * carry. Anything else is the caller's mistake and is reported as one here,
 * where the flag is read, rather than surviving into a computation that then
 * answers a question nobody asked.
 */
export function flagCount(args: ParsedArgs, name: string, spec: CountFlag): number | null {
  if (!NUMERIC_FLAGS.has(name)) {
    throw new Error(`--${name} is read as a number but is not in NUMERIC_FLAGS, so flagString would still serve it`);
  }
  const raw = args.flags.get(name);
  if (typeof raw !== 'string') return null;
  const refuse = (): never => {
    throw new UserFacingError(`--${name} ${raw} is not ${spec.what}`, [...spec.help], EXIT_USAGE);
  };
  if (!/^\d+$/.test(raw)) return refuse();
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) return refuse();
  if (spec.min !== undefined && value < spec.min) return refuse();
  if (spec.max !== undefined && value > spec.max) return refuse();
  return value;
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
