#!/usr/bin/env node
// The published binary. All behaviour lives in dist/src/cli/main.js so that the
// bin shim and the daemon's own re-spawn of itself run identical code.
await import('../dist/src/cli/main.js');
