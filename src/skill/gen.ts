import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_NAME, skillMarkdown } from './skill.js';

/**
 * Regenerates the checked-in public skill. `npm run genskill` writes it;
 * test/skill.test.ts fails if the file on disk no longer matches, so the
 * generated copy cannot silently rot.
 */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const target = join(packageRoot, 'skills', SKILL_NAME, 'SKILL.md');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, skillMarkdown(), { mode: 0o644 });
process.stdout.write(`wrote ${target}\n`);
