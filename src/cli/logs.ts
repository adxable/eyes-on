import { readFileSync, statSync } from 'node:fs';
import type { Context } from './context.js';
import { flagCount } from './args.js';
import { emitDoc, EXIT_OK } from './output.js';
import type { ToonObject, ToonValue } from './toon.js';

/**
 * `eyes-on axi logs` - the tail of the two logs eyes-on keeps.
 *
 * It exists because an agent that has just been told a daemon is unhealthy has
 * no way to look, and telling it to open a file it cannot name is not an
 * answer. Both logs are reported together with their sizes, because "empty"
 * and "not there" are different diagnoses and only one of them is a problem.
 *
 * Lines are a list, not a blob: `axi` output is parsed. That is why the two
 * logs are a nested object keyed by name rather than a list of records: a TOON
 * table row holds only scalars, so a record carrying its own list of lines has
 * nowhere to put them.
 */
export const DEFAULT_LOG_LINES = 40;

export function logsCommand(context: Context): number {
  // A preference like `--n`: the whole token is read, and a number out of range
  // is clamped because how much tail to print is eyes-on's to decide.
  const asked = flagCount(context.args, 'lines', {
    what: 'a number',
    help: ['Pass a whole number of lines, for example `--lines 100`'],
  });
  const lines = asked !== null && asked > 0 ? Math.min(1000, asked) : DEFAULT_LOG_LINES;

  const doc: ToonObject = {
    root: context.paths.root,
    lines,
    logs: {
      daemon: readTail(context.paths.daemonLog, 'daemon', lines),
      cli: readTail(context.paths.cliLog, 'cli', lines),
    } as ToonValue,
    exit_code: EXIT_OK,
    help: [
      'Logs are rotated at the size set by logs.max_bytes in the state root\'s config.yaml',
      'A log that is absent has simply never been written to; it is not an error on its own',
    ] as ToonValue,
  };
  emitDoc(context.writers, context.format, doc, () => renderMarkdown(doc));
  return EXIT_OK;
}

function readTail(path: string, name: string, count: number): ToonObject {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { name, path, present: false, bytes: 0, lines: [] as ToonValue };
  }
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { name, path, present: true, bytes: size, error: (error as Error).message, lines: [] as ToonValue };
  }
  const all = text.split('\n').filter((line) => line.length > 0);
  return { name, path, present: true, bytes: size, lines: all.slice(-count) as ToonValue };
}

function renderMarkdown(doc: ToonObject): string {
  const out: string[] = [`# eyes-on logs - last ${String(doc.lines)} lines`, ''];
  for (const entry of Object.values((doc.logs ?? {}) as ToonObject) as unknown as ToonObject[]) {
    out.push(`## ${String(entry.name)} (\`${String(entry.path)}\`)`, '');
    const lines = (entry.lines ?? []) as unknown as string[];
    if (!entry.present) out.push('_not written yet._');
    else if (lines.length === 0) out.push('_empty._');
    else out.push('```', ...lines, '```');
    out.push('');
  }
  return out.join('\n');
}
