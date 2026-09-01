import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hooksDir } from './git.js';

/**
 * The optional `post-commit` trigger in the working clone (report D3, K5, K6).
 *
 * Three measured facts decide the whole design (report Appendix D):
 *
 *   D.1  the hook costs +10 ms on a commit once Node is warm;
 *   D.2  a post-commit hook that *fails* does not stop the commit - the exact
 *        opposite of no-mistakes' pre-receive, which rejects the push. That is
 *        why eyes-on's trigger lives here and not in a gate;
 *   D.3  pipeline commits happen in a worktree carved from the no-mistakes
 *        gate, so they fire the *gate's* hooks, not the clone's. There is no
 *        feedback loop, and that is a property of git rather than an agreement.
 *
 * The slot is free on the measured clone (Appendix A2), but "free today" is not
 * a licence to overwrite. If a foreign hook is present it is moved aside to
 * `post-commit.eyes-on-user` and exec'd by the managed wrapper - the same
 * preservation pattern no-mistakes uses for its own gate hook
 * (internal/git/hook.go:17, 72-107). Installing over somebody's husky setup
 * would be exactly the kind of collision this product exists to avoid.
 */

export const PRESERVED_HOOK = 'post-commit.eyes-on-user';
export const HOOK_MARKER = '# eyes-on post-commit hook';

/**
 * The hook carries the state root it was installed for, because it must reach
 * the daemon that actually registered this clone. A hook that inherited the
 * root from the committing shell's EYES_HOME would silently talk to
 * `~/.eyes-on` after an `EYES_HOME=/srv/... eyes-on init --watch`, and since
 * the hook discards output and always exits 0, nobody would ever find out.
 */
export function postCommitHookScript(binary: string, stateRoot: string): string {
  return `#!/bin/sh
${HOOK_MARKER}
# Notifies the eyes-on daemon that a new head exists, then gets out of the way.
# This hook must never fail a commit: every path below exits 0.
EYES_ON_BIN=${shellQuote(binary)}
EYES_ON_ROOT=${shellQuote(stateRoot)}
if [ ! -x "$EYES_ON_BIN" ]; then
  EYES_ON_BIN=$(command -v eyes-on 2>/dev/null || echo '')
fi
if [ -n "$EYES_ON_BIN" ] && [ "\${EYES_ON_HOOK_DISABLED:-0}" != "1" ]; then
  ( EYES_ON_HOOK=1 "$EYES_ON_BIN" daemon notify-commit --root "$EYES_ON_ROOT" >/dev/null 2>&1 & ) >/dev/null 2>&1
fi
HOOK_PATH=$0
case "$HOOK_PATH" in
  */*) HOOK_DIR=\${HOOK_PATH%/*} ;;
  *) HOOK_DIR=. ;;
esac
USER_HOOK="$HOOK_DIR/${PRESERVED_HOOK}"
if [ -x "$USER_HOOK" ]; then
  "$USER_HOOK" "$@" || :
fi
exit 0
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isManagedHook(content: string): boolean {
  return content.includes(HOOK_MARKER);
}

export type HookAction = 'installed' | 'refreshed' | 'unchanged' | 'preserved-foreign';

export interface HookResult {
  action: HookAction;
  path: string;
  /** Set when a foreign hook was moved aside. */
  preservedPath: string | null;
}

/**
 * Installs or refreshes the managed post-commit hook in the clone's hooks
 * directory, preserving any hook that was already there.
 */
export function installPostCommitHook(clonePath: string, binary: string, stateRoot: string): HookResult {
  const dir = hooksDir(clonePath);
  if (!dir) throw new Error(`cannot resolve the hooks directory of ${clonePath}`);
  mkdirSync(dir, { recursive: true });
  const hookPath = join(dir, 'post-commit');
  const companion = join(dir, PRESERVED_HOOK);
  const desired = postCommitHookScript(binary, stateRoot);

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, 'utf8');
    if (existing === desired) {
      return { action: 'unchanged', path: hookPath, preservedPath: null };
    }
    if (isManagedHook(existing)) {
      writeFileSync(hookPath, desired, { mode: 0o755 });
      chmodSync(hookPath, 0o755);
      return { action: 'refreshed', path: hookPath, preservedPath: existsSync(companion) ? companion : null };
    }
    if (existsSync(companion)) {
      throw new Error(
        `refusing to preserve the existing post-commit hook: ${companion} already exists. Move or delete it, then re-run eyes-on init --watch`,
      );
    }
    renameSync(hookPath, companion);
    chmodSync(companion, 0o755);
    writeFileSync(hookPath, desired, { mode: 0o755 });
    chmodSync(hookPath, 0o755);
    return { action: 'preserved-foreign', path: hookPath, preservedPath: companion };
  }

  writeFileSync(hookPath, desired, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
  return { action: 'installed', path: hookPath, preservedPath: null };
}

export interface HookStatus {
  path: string | null;
  present: boolean;
  managed: boolean;
  preservedForeign: boolean;
}

export function inspectPostCommitHook(clonePath: string): HookStatus {
  const dir = hooksDir(clonePath);
  if (!dir) return { path: null, present: false, managed: false, preservedForeign: false };
  const hookPath = join(dir, 'post-commit');
  if (!existsSync(hookPath)) {
    return { path: hookPath, present: false, managed: false, preservedForeign: existsSync(join(dir, PRESERVED_HOOK)) };
  }
  const content = readFileSync(hookPath, 'utf8');
  return {
    path: hookPath,
    present: true,
    managed: isManagedHook(content),
    preservedForeign: existsSync(join(dir, PRESERVED_HOOK)),
  };
}

/** Removes the managed hook and restores a preserved foreign one. Never
 *  touches a hook eyes-on did not write. */
export function removePostCommitHook(clonePath: string): boolean {
  const status = inspectPostCommitHook(clonePath);
  if (!status.path || !status.present || !status.managed) return false;
  const dir = status.path.slice(0, status.path.lastIndexOf('/'));
  const companion = join(dir, PRESERVED_HOOK);
  rmSync(status.path, { force: true });
  if (existsSync(companion)) renameSync(companion, status.path);
  return true;
}
