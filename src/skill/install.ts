import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SKILL_NAME, skillMarkdown } from './skill.js';

/**
 * Installing `/eyes-on` into the user-level skill bases (report M20).
 *
 * Both bases are written for the same reason no-mistakes writes both
 * (internal/skill/install.go:15-18): `~/.claude/skills` is Claude Code's
 * personal-skill location and `~/.agents/skills` is the vendor-neutral
 * convention other agents read. Writing one and hoping is how a skill goes
 * missing on the machine that needed it.
 *
 * Install is idempotent - identical content is not rewritten - and it follows
 * symlinks, because consolidating the two bases with a link is a normal thing
 * for a user to have done.
 */

export const INSTALL_BASES = [join('.claude', 'skills'), join('.agents', 'skills')] as const;

export interface SkillInstallResult {
  path: string;
  written: boolean;
}

/** Resolves symlinked path components so MkdirAll does not trip on a dangling
 *  link pointing at a directory that does not exist yet. */
function resolveThroughSymlinks(path: string): string {
  try {
    if (existsSync(path)) return realpathSync(path);
  } catch {
    // Fall through to resolving the parent.
  }
  const parent = dirname(path);
  if (parent === path) return path;
  const resolvedParent = resolveThroughSymlinks(parent);
  const candidate = join(resolvedParent, path.slice(parent.length + 1));
  try {
    if (lstatSync(candidate).isSymbolicLink()) return realpathSync(candidate);
  } catch {
    // Not a link, or not there yet: the plain join is the answer.
  }
  return candidate;
}

export function installSkill(root: string = homedir()): SkillInstallResult[] {
  const content = skillMarkdown();
  const results: SkillInstallResult[] = [];
  for (const base of INSTALL_BASES) {
    const target = resolveThroughSymlinks(join(root, base, SKILL_NAME));
    mkdirSync(target, { recursive: true });
    const file = join(target, 'SKILL.md');
    let written = true;
    try {
      written = readFileSync(file, 'utf8') !== content;
    } catch {
      written = true;
    }
    if (written) writeFileSync(file, content, { mode: 0o644 });
    results.push({ path: file, written });
  }
  return results;
}

export interface SkillPresence {
  path: string;
  present: boolean;
  current: boolean;
}

export function inspectSkill(root: string = homedir()): SkillPresence[] {
  const content = skillMarkdown();
  return INSTALL_BASES.map((base) => {
    const file = join(root, base, SKILL_NAME, 'SKILL.md');
    try {
      return { path: file, present: true, current: readFileSync(file, 'utf8') === content };
    } catch {
      return { path: file, present: false, current: false };
    }
  });
}
