/**
 * A deliberately small YAML subset: block mappings, block sequences, scalars,
 * comments, and single-level flow collections (`{a: 1}` / `[a, b]`).
 *
 * Why not a dependency: the whole product is dependency-free by design (report
 * section 7, measured in Appendix A1), and the two documents eyes-on reads -
 * the global `config.yaml` it writes itself and the repository `.eyes-on.yml`
 * sketched in Appendix C.3 - live entirely inside this subset. Anything
 * outside it is rejected loudly rather than half-understood: a config file
 * that silently parses to the wrong thing is worse than one that fails.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };
export type YamlMap = { [key: string]: YamlValue };

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'YamlError';
    this.line = line;
  }
}

interface Line {
  indent: number;
  text: string;
  number: number;
  /** The line exactly as written, comment and all. A block scalar's content is
   *  text, so it is taken from here rather than from the structural `text`,
   *  where a `#` would have been read as a comment and the indentation lost. */
  raw: string;
}

function scanLines(source: string): Line[] {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const withoutComment = stripComment(raw);
    if (withoutComment.trim().length === 0) return;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    lines.push({ indent, text: withoutComment.trim(), number: index + 1, raw });
  });
  return lines;
}

/** Strips a trailing `#` comment that is not inside a quoted scalar. */
function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1] ?? ''))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

export function parseScalar(token: string, line = 0): YamlValue {
  const text = token.trim();
  if (text.length === 0) return null;
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0] as string;
    if (!text.endsWith(quote) || text.length < 2) {
      throw new YamlError(`unterminated quoted scalar ${text}`, line);
    }
    const body = text.slice(1, -1);
    return quote === '"' ? body.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\') : body;
  }
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)) return Number(text);
  return text;
}

/** Splits a flow collection body on top-level commas. */
function splitFlow(body: string, line: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    if (ch === '}' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote) throw new YamlError('unterminated quoted scalar in flow collection', line);
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

function parseFlow(text: string, line: number): YamlValue {
  if (text.startsWith('{')) {
    if (!text.endsWith('}')) throw new YamlError('unterminated flow mapping', line);
    const map: YamlMap = {};
    for (const part of splitFlow(text.slice(1, -1), line)) {
      const separator = part.indexOf(':');
      if (separator < 0) throw new YamlError(`flow mapping entry without a key: ${part.trim()}`, line);
      map[part.slice(0, separator).trim()] = parseValueToken(part.slice(separator + 1), line);
    }
    return map;
  }
  if (!text.endsWith(']')) throw new YamlError('unterminated flow sequence', line);
  return splitFlow(text.slice(1, -1), line).map((part) => parseValueToken(part, line));
}

function parseValueToken(token: string, line: number): YamlValue {
  const text = token.trim();
  if (text.startsWith('{') || text.startsWith('[')) return parseFlow(text, line);
  return parseScalar(text, line);
}

/** Splits `key: value`, honouring quoted keys and colons inside values. */
function splitKey(text: string, line: number): { key: string; rest: string } {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':' && (i + 1 === text.length || /\s/.test(text[i + 1] ?? ''))) {
      const rawKey = text.slice(0, i).trim();
      const key = rawKey.startsWith('"') || rawKey.startsWith("'") ? String(parseScalar(rawKey, line)) : rawKey;
      return { key, rest: text.slice(i + 1).trim() };
    }
  }
  throw new YamlError(`expected "key: value", got ${JSON.stringify(text)}`, line);
}

function parseBlock(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const first = lines[start];
  if (!first) return { value: null, next: start };
  if (first.text.startsWith('- ') || first.text === '-') {
    const items: YamlValue[] = [];
    let index = start;
    while (index < lines.length) {
      const line = lines[index];
      if (!line || line.indent !== indent || !(line.text.startsWith('- ') || line.text === '-')) break;
      const body = line.text === '-' ? '' : line.text.slice(2).trim();
      if (body.length === 0) {
        const nested = parseBlock(lines, index + 1, (lines[index + 1]?.indent ?? indent + 1));
        items.push(nested.value);
        index = nested.next;
        continue;
      }
      if (body.includes(': ') || body.endsWith(':')) {
        // Inline first key of a sequence item mapping: `- glob: "..."`.
        const virtual: Line[] = [{ indent: indent + 2, text: body, number: line.number, raw: line.raw }];
        let scan = index + 1;
        // The item's own keys sit at whatever indentation the document uses;
        // they are re-based onto `indent + 2` so the inline first key lines up
        // with them. Relative depth *inside* the item is preserved, or a nested
        // mapping - or a block scalar, whose content is indented deeper than
        // its key - would be flattened into the item's own keys.
        const itemIndent = lines[scan]?.indent ?? indent + 2;
        while (scan < lines.length && (lines[scan]?.indent ?? -1) > indent) {
          const continuation = lines[scan];
          if (!continuation) break;
          virtual.push({
            indent: indent + 2 + (continuation.indent - itemIndent),
            text: continuation.text,
            number: continuation.number,
            raw: continuation.raw,
          });
          scan += 1;
        }
        const nested = parseBlock(virtual, 0, indent + 2);
        items.push(nested.value);
        index = scan;
        continue;
      }
      items.push(parseValueToken(body, line.number));
      index += 1;
    }
    return { value: items, next: index };
  }

  const map: YamlMap = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('unexpected indentation', line.number);
    const { key, rest } = splitKey(line.text, line.number);
    if (rest === '|' || rest === '|-') {
      const block = readBlockScalar(lines, index + 1, indent, rest === '|-');
      map[key] = block.value;
      index = block.next;
      continue;
    }
    if (rest.startsWith('>') || rest === '|+') {
      // Folded and keep-chomped block scalars are outside the subset. Refusing
      // them is the rule this parser is built on: a document that silently
      // parses to the wrong thing is worse than one that fails.
      throw new YamlError(`block scalar style ${JSON.stringify(rest)} is outside the supported subset (use | or |-)`, line.number);
    }
    if (rest.length > 0) {
      map[key] = parseValueToken(rest, line.number);
      index += 1;
      continue;
    }
    const child = lines[index + 1];
    if (!child || child.indent <= indent) {
      map[key] = null;
      index += 1;
      continue;
    }
    const nested = parseBlock(lines, index + 1, child.indent);
    map[key] = nested.value;
    index = nested.next;
  }
  return { value: map, next: index };
}

/**
 * A literal block scalar (`|` or `|-`).
 *
 * Content is every following line indented deeper than the key, with that
 * indentation removed and nothing else interpreted. `|` keeps one trailing
 * newline, `|-` keeps none - the two chomping modes anybody actually writes.
 *
 * One limitation, stated rather than hidden: blank lines inside the block are
 * dropped, because the scanner removes them before the parser ever sees the
 * document. Every value eyes-on reads or writes in this style is a few lines of
 * prose with no paragraph breaks.
 */
function readBlockScalar(
  lines: Line[],
  start: number,
  keyIndent: number,
  strip: boolean,
): { value: string; next: number } {
  const body: string[] = [];
  let index = start;
  let contentIndent: number | null = null;
  while (index < lines.length) {
    const line = lines[index];
    if (!line || line.indent <= keyIndent) break;
    if (contentIndent === null) contentIndent = line.indent;
    body.push(line.raw.slice(Math.min(contentIndent, line.raw.length - line.raw.trimStart().length)).trimEnd());
    index += 1;
  }
  const text = body.join('\n');
  return { value: strip ? text : `${text}\n`, next: index };
}

export function parseYaml(source: string): YamlValue {
  const lines = scanLines(source);
  if (lines.length === 0) return {};
  const { value } = parseBlock(lines, 0, lines[0]?.indent ?? 0);
  return value;
}

function stringifyScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value !== 'string') return String(value);
  if (value.length === 0) return '""';
  if (/^[A-Za-z0-9_./@:+-]+$/.test(value) && !/^(true|false|null|~)$/.test(value) && !/^-?[0-9]/.test(value)) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** Emits the same subset parseYaml accepts, so a written file round-trips. */
export function stringifyYaml(value: YamlValue, depth = 0): string {
  const pad = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const body = stringifyYaml(item, depth + 1);
          return `${pad}-\n${body}`;
        }
        return `${pad}- ${stringifyScalar(item as string | number | boolean | null)}\n`;
      })
      .join('');
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, child]) => {
        if (child !== null && typeof child === 'object') {
          const body = stringifyYaml(child, depth + 1);
          return body.trim().length === 0 ? `${pad}${key}: {}\n` : `${pad}${key}:\n${body}`;
        }
        return `${pad}${key}: ${stringifyScalar(child as string | number | boolean | null)}\n`;
      })
      .join('');
  }
  return `${pad}${stringifyScalar(value)}\n`;
}
