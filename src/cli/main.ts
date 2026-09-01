/**
 * Executable entry point.
 *
 * Two callers reach this file and both must behave identically: the `eyes-on`
 * bin shim, and `node dist/src/cli/main.js daemon run --root <dir>` as spawned
 * by the daemon lifecycle and by the OS service. Keeping the dispatcher itself
 * in run.ts - a module with no side effects - is what lets tests exercise the
 * whole CLI in-process without a subprocess and without touching process exit.
 */
import { run } from './run.js';
import { EXIT_ERROR, processWriters } from './output.js';

// stderr is the AXI progress channel, so Node's unconditional `node:sqlite`
// ExperimentalWarning (report R2) must not appear there and look like eyes-on
// output. Every other warning is still surfaced.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) return;
  process.stderr.write(`${warning.name}: ${warning.message}\n`);
});

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    processWriters.err(`error: ${(error as Error).message ?? 'unexpected error'}\n`);
    process.exitCode = EXIT_ERROR;
  });
