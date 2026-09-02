import { readFileSync, statSync } from 'node:fs';
import type { Context } from './context.js';
import { flagString } from './args.js';
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
 * Lines are a list, not a blob: `axi` output is parsed.
 */
export const DEFAULT_LOG_LINES = 40;

export function logsCommand(context: Context): number {
  const requested = Number.parseInt(flagString(context.args, 'lines') ?? '', 10);
  const lines = Number.isFinite(requested) && requested > 0 ? Math.min(1000, requested) : DEFAULT_LOG_LINES;

  const doc: ToonObject = {
    root: context.paths.root,
    lines,
    logs: [
      readTail(context.paths.daemonLog, 'daemon', lines),
      readTail(context.paths.cliLog, 'cli', lines),
    ] as ToonValue,
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
  for (const entry of (doc.logs as unknown as ToonObject[]) ?? []) {
    out.push(`## ${String(entry.name)} (\`${String(entry.path)}\`)`, '');
    const lines = (entry.lines ?? []) as unknown as string[];
    if (!entry.present) out.push('_not written yet._');
    else if (lines.length === 0) out.push('_empty._');
    else out.push('```', ...lines, '```');
    out.push('');
  }
  return out.join('\n');
}
