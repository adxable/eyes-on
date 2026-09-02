/**
 * Minimal TOON encoder for the AXI surface (report M15).
 *
 * TOON is the machine-readable stdout shape no-mistakes uses; eyes-on adopts
 * it wholesale so an agent that can already read one tool can read the other.
 * The subset rendered here is the subset the CLI actually emits:
 *
 *   key: scalar
 *   key[N]: a,b,c                    array of scalars
 *   key[N]{f1,f2}:                   array of objects, one comma-joined row per
 *     v1,v2                          element, indented one level
 *   key:                             nested object, fields indented one level
 *     sub: v
 *
 * Arrays of objects are rendered as a table over the union of the elements'
 * keys, with absent fields rendered empty. That keeps the header honest when
 * elements differ instead of silently dropping a field.
 */

export type ToonScalar = string | number | boolean | null;
export type ToonValue = ToonScalar | ToonValue[] | { [key: string]: ToonValue };
export type ToonObject = { [key: string]: ToonValue };

/**
 * A payload this encoder has no rendering for.
 *
 * A table row is one record of scalar cells, so a row carrying a nested list or
 * object has no place to put it. That used to be discovered inside `trim` on an
 * array, which reached the agent as a `TypeError` where a machine payload was
 * promised - the opposite of the output contract. Refusing here names the key
 * and the field instead, and the caller reports it in the contract's shape.
 */
export class ToonEncodeError extends Error {
  readonly help: string[];
  constructor(message: string, help: string[]) {
    super(message);
    this.name = 'ToonEncodeError';
    this.help = help;
  }
}

const INDENT = '  ';

/** Literals a bare string would be misread as, so they get quoted. */
const RESERVED = /^(true|false|null)$/i;
const NUMERIC = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/;

function needsQuoting(value: string): boolean {
  if (value.length === 0) return true;
  if (value !== value.trim()) return true;
  if (/[",\n\r]/.test(value)) return true;
  if (value.includes(': ')) return true;
  if (/^[[{\-#]/.test(value)) return true;
  if (RESERVED.test(value) || NUMERIC.test(value)) return true;
  return false;
}

export function encodeScalar(value: ToonScalar): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (!needsQuoting(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

function isScalar(value: ToonValue): value is ToonScalar {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isPlainObject(value: ToonValue): value is ToonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unionKeys(rows: ToonObject[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

function encodeField(key: string, value: ToonValue, depth: number): string[] {
  const pad = INDENT.repeat(depth);
  if (isScalar(value)) {
    return [`${pad}${key}: ${encodeScalar(value)}`];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${key}[0]:`];
    if (value.every(isScalar)) {
      return [`${pad}${key}[${value.length}]: ${value.map(encodeScalar).join(',')}`];
    }
    const rows = value.filter(isPlainObject);
    if (rows.length === value.length) {
      const fields = unionKeys(rows);
      const lines = [`${pad}${key}[${value.length}]{${fields.join(',')}}:`];
      for (const row of rows) {
        const cells = fields.map((field) => {
          const cell = row[field];
          if (cell === undefined || cell === null) return '';
          if (!isScalar(cell)) {
            throw new ToonEncodeError(
              `${key}[].${field} is ${Array.isArray(cell) ? 'a list' : 'an object'}, and a TOON table row holds only scalars`,
              [
                `Emit ${key} as a nested object keyed by row, so ${field} can be a list of its own`,
                'Or ask for `--format json`, which carries any shape',
              ],
            );
          }
          return encodeScalar(cell);
        });
        lines.push(`${pad}${INDENT}${cells.join(',')}`);
      }
      return lines;
    }
    // Mixed arrays are not part of the emitted surface; render as scalars so
    // output stays parseable rather than throwing at the last moment.
    return [`${pad}${key}[${value.length}]: ${value.map((v) => encodeScalar(JSON.stringify(v))).join(',')}`];
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  const lines = [`${pad}${key}:`];
  for (const [childKey, childValue] of entries) {
    lines.push(...encodeField(childKey, childValue as ToonValue, depth + 1));
  }
  return lines;
}

/** Renders a complete TOON document, newline terminated. */
export function encodeToon(doc: ToonObject): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) continue;
    lines.push(...encodeField(key, value as ToonValue, 0));
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
