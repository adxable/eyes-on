import { encodeToon, type ToonObject, type ToonValue } from './toon.js';

/**
 * Output contract, adopted verbatim from the AXI surface (report M15,
 * Appendix C.1):
 *
 *   - machine payload on stdout, TOON by default
 *   - human-directed progress on stderr, never mixed into the payload
 *   - exit 0 success or no-op, 1 error, 2 usage error
 *   - every failure is `error:` plus `help:`, in both output shapes, so an
 *     agent never has to guess what to do next
 */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export type Format = 'toon' | 'json' | 'md';

export class ExitError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
  }
}

/** A failure the CLI reports as `error:` + `help:` rather than a stack trace. */
export class UserFacingError extends Error {
  readonly code: number;
  readonly help: string[];
  constructor(message: string, help: string[] = [], code: number = EXIT_ERROR) {
    super(message);
    this.name = 'UserFacingError';
    this.help = help;
    this.code = code;
  }
}

export interface Writers {
  out: (chunk: string) => void;
  err: (chunk: string) => void;
}

export const processWriters: Writers = {
  out: (chunk) => process.stdout.write(chunk),
  err: (chunk) => process.stderr.write(chunk),
};

/** Progress goes to stderr so stdout stays a clean machine payload. */
export function progress(writers: Writers, message: string): void {
  writers.err(`${message}\n`);
}

/**
 * The Markdown rendering is accepted as a thunk as well as a string, because a
 * command whose human rendering costs something - re-reading a hook, asking the
 * service manager - must not pay for it under `--format json`, where it is
 * discarded unread.
 */
export function emitDoc(
  writers: Writers,
  format: Format,
  doc: ToonObject,
  markdown?: string | (() => string),
): void {
  if (format === 'json') {
    writers.out(`${JSON.stringify(doc, null, 2)}\n`);
    return;
  }
  if (format === 'md' && markdown !== undefined) {
    const rendered = typeof markdown === 'function' ? markdown() : markdown;
    writers.out(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
    return;
  }
  writers.out(encodeToon(doc));
}

/**
 * Renders a failure. In machine formats the error is part of the stdout
 * payload (an agent parses one stream); in Markdown it goes to stderr so a
 * human's stdout is not polluted with a half-written report. Both carry the
 * same two keys.
 */
export function emitError(
  writers: Writers,
  format: Format,
  message: string,
  help: string[] = [],
): void {
  const doc: ToonObject = { error: message };
  if (help.length > 0) doc.help = help as ToonValue;
  if (format === 'md') {
    writers.err(`error: ${message}\n`);
    for (const line of help) writers.err(`help: ${line}\n`);
    return;
  }
  emitDoc(writers, format, doc);
}
