import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Recursion containment (report M24, K16).
 *
 * no-mistakes stamps NO_MISTAKES_GATE=1 on every agent it spawns and says in
 * internal/agent/env.go:6-17 that the variable exists precisely so cooperating
 * tools can recognise the situation. eyes-on takes it at face value: called
 * from inside a no-mistakes run, it refuses to record anything, because the
 * work it would assess is work in progress that the pipeline is still
 * rewriting. Reads keep working - a refusal to *look* would be useless.
 *
 * The second detector is the working directory. A process whose cwd sits under
 * `<NM_HOME>/worktrees` is a pipeline descendant whatever its environment says,
 * and it is also the exact shape no-mistakes reaps by cwd
 * (internal/procreap/procreap.go:1-40). eyes-on stays out of there in both
 * directions: it never sets its own cwd there, and it refuses to mutate when it
 * finds itself there.
 */

export type GuardReason = 'gate-env' | 'gate-cwd';

export interface GuardVerdict {
  /** True when this process is running inside a no-mistakes pipeline run. */
  insideGate: boolean;
  reason: GuardReason | null;
  detail: string;
}

export interface GuardInputs {
  env: NodeJS.ProcessEnv;
  cwd: string;
}

function nmWorktreesDir(env: NodeJS.ProcessEnv): string {
  const home = env.NM_HOME && env.NM_HOME.length > 0 ? env.NM_HOME : join(homedir(), '.no-mistakes');
  return join(home, 'worktrees');
}

function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  if (rel === '') return true;
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

export function classify(inputs: GuardInputs = { env: process.env, cwd: process.cwd() }): GuardVerdict {
  if (inputs.env.NO_MISTAKES_GATE === '1') {
    return {
      insideGate: true,
      reason: 'gate-env',
      detail: 'NO_MISTAKES_GATE=1 is set, so this process is a no-mistakes pipeline descendant',
    };
  }
  const worktrees = physical(nmWorktreesDir(inputs.env));
  const cwd = physical(inputs.cwd);
  if (isInside(cwd, worktrees)) {
    return {
      insideGate: true,
      reason: 'gate-cwd',
      detail: `working directory ${cwd} is under the no-mistakes worktree root ${worktrees}`,
    };
  }
  return { insideGate: false, reason: null, detail: '' };
}

/** Help lines a refusal carries, so the caller knows the read path still works. */
export function refusalHelp(commandName: string): string[] {
  return [
    `eyes-on ${commandName} mutates eyes-on state, and eyes-on refuses to do that from inside a no-mistakes run`,
    'Run it from your working clone after the pipeline finishes, not from a pipeline step',
    'Read-only commands still work here: `eyes-on status`, `eyes-on doctor`, `eyes-on daemon status`',
  ];
}
