/**
 * Path globbing, hand-written for the same reason as the YAML subset and the
 * TOON encoder: zero runtime dependencies (report section 7).
 *
 * The subset is the one `.eyes-on.yml` actually uses (Appendix C.3):
 *
 *   `**`      any number of path segments, including none
 *   `*`       any run of characters inside one segment
 *   `?`       one character inside one segment
 *   `{a,b}`   alternation, nestable
 *   `[abc]`   a character class, with `!` or `^` negating it
 *
 * Two conventions matter because a rule that silently matches nothing is worse
 * than one that fails loudly:
 *
 *   - a pattern with no `/` matches by basename as well as by full path, so
 *     `*.ts` means what everyone expects it to mean;
 *   - a pattern ending in `/` or in `/**` matches the directory's contents, and
 *     a bare directory path (`packages/provisioning`) does not - the config
 *     sketch always spells the recursive form, and guessing would make a
 *     hard rule's reach depend on a trailing character nobody looked at.
 */

export class GlobError extends Error {
  constructor(pattern: string, detail: string) {
    super(`invalid glob ${JSON.stringify(pattern)}: ${detail}`);
    this.name = 'GlobError';
  }
}

/** Characters that are literal in a glob but special in a regular expression. */
function escapeLiteral(char: string): string {
  return /[.+^$(){}|\\]/.test(char) ? `\\${char}` : char;
}

/**
 * Compiles one glob to a regular expression source anchored at both ends.
 *
 * `**` is handled by looking at the whole segment rather than at the two stars
 * alone: `a/**\/b` must match `a/b`, which means the separator that follows the
 * stars has to become optional. Doing that here, while the segment boundary is
 * still visible, is what keeps the common `dir/**` pattern from needing a
 * special case at every call site.
 */
function compile(pattern: string): string {
  let out = '';
  let index = 0;
  const braces: number[] = [];

  while (index < pattern.length) {
    const char = pattern[index] as string;

    // `**` as a whole segment: consume the following slash with it.
    if (char === '*' && pattern[index + 1] === '*') {
      const atSegmentStart = index === 0 || pattern[index - 1] === '/';
      let after = index + 2;
      const atSegmentEnd = after >= pattern.length || pattern[after] === '/';
      if (atSegmentStart && atSegmentEnd) {
        if (pattern[after] === '/') {
          after += 1;
          // `**/` matches zero or more segments, so the slash is part of the
          // optional group rather than a separator that must be present.
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
        index = after;
        continue;
      }
      // `**` inside a segment (`a**b`) is no more than a `*`.
      out += '[^/]*';
      index += 2;
      continue;
    }

    if (char === '*') {
      out += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      index += 1;
      continue;
    }
    if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close < 0) throw new GlobError(pattern, 'unterminated character class');
      let body = pattern.slice(index + 1, close);
      let negate = '';
      if (body.startsWith('!') || body.startsWith('^')) {
        negate = '^';
        body = body.slice(1);
      }
      out += `[${negate}${body.replace(/\\/g, '\\\\')}]`;
      index = close + 1;
      continue;
    }
    if (char === '{') {
      braces.push(index);
      out += '(?:';
      index += 1;
      continue;
    }
    if (char === '}') {
      if (braces.length === 0) throw new GlobError(pattern, 'unmatched }');
      braces.pop();
      out += ')';
      index += 1;
      continue;
    }
    if (char === ',' && braces.length > 0) {
      out += '|';
      index += 1;
      continue;
    }
    out += escapeLiteral(char);
    index += 1;
  }

  if (braces.length > 0) throw new GlobError(pattern, 'unmatched {');
  return out;
}

export interface Glob {
  readonly source: string;
  matches(path: string): boolean;
}

const cache = new Map<string, Glob>();

/** Compiles a glob, memoised: a hard rule is tested against every changed file
 *  and a backtest against every file in the repository. */
export function glob(pattern: string): Glob {
  const cached = cache.get(pattern);
  if (cached) return cached;

  const trimmed = pattern.trim();
  if (trimmed.length === 0) throw new GlobError(pattern, 'empty pattern');
  // A trailing slash names a directory's contents; spell it as such.
  const normalized = trimmed.endsWith('/') ? `${trimmed}**` : trimmed;
  const full = new RegExp(`^${compile(normalized)}$`);
  // A pattern with no separator is matched against the basename too, so
  // `*.md` means "any markdown file" rather than "a markdown file at the root".
  const basenameToo = !normalized.includes('/');

  const compiled: Glob = {
    source: pattern,
    matches(path: string): boolean {
      const clean = normalizePath(path);
      if (full.test(clean)) return true;
      if (!basenameToo) return false;
      const slash = clean.lastIndexOf('/');
      return slash >= 0 && full.test(clean.slice(slash + 1));
    },
  };
  cache.set(pattern, compiled);
  return compiled;
}

/** Repository-relative, forward-slashed, with no `./` prefix. Git already
 *  reports paths this way; user-supplied paths do not always. */
export function normalizePath(path: string): string {
  let clean = path.replace(/\\/g, '/');
  while (clean.startsWith('./')) clean = clean.slice(2);
  return clean;
}

/** True when any of the patterns matches. An empty list matches nothing, which
 *  is what makes an absent `exclude` harmless and an absent `include` visible. */
export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return glob(pattern).matches(path);
    } catch {
      // An unusable pattern is reported where the config is read; here it
      // simply matches nothing, so one bad entry cannot swallow a whole list.
      return false;
    }
  });
}

/** The patterns that match, in the order given. Used where a report has to name
 *  which rule fired, not merely that one did. */
export function matching(path: string, patterns: readonly string[]): string[] {
  return patterns.filter((pattern) => {
    try {
      return glob(pattern).matches(path);
    } catch {
      return false;
    }
  });
}
