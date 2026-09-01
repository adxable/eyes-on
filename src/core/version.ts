import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Product identity. Every derived identifier (state root, service label, skill
 *  name, PR comment marker) hangs off these two constants, so renaming the
 *  product is a one-place change. */
export const PRODUCT_NAME = 'eyes-on';
export const SERVICE_LABEL_BASE = 'com.adxable.eyes-on.daemon';

let cachedVersion: string | null = null;

/** Version read from the installed package manifest. Read lazily and cached so
 *  a CLI invocation that never prints a version pays nothing. */
export function version(): string {
  if (cachedVersion !== null) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/src/core -> dist/src -> dist -> package root
  const manifest = join(here, '..', '..', '..', 'package.json');
  try {
    const raw = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
    cachedVersion = raw.version ?? '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}
