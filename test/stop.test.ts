import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Paths } from '../src/core/paths.js';
import { daemonState, stopDaemon } from '../src/daemon/lifecycle.js';
import { processAlive } from '../src/daemon/lock.js';
import { run as runCli } from '../src/cli/run.js';
import type { Writers } from '../src/cli/output.js';
import { stateRoot as shortStateRoot, tempDir } from './helpers.js';

/**
 * Ending a daemon that answers nothing.
 *
 * The state under test is `wedged`: a live process holds the singleton lock
 * while the socket says nothing, so there is no shutdown to ask for and the
 * only thing left is a signal. Two properties are what these tests exist for,
 * and neither is visible from a passing stop:
 *
 *   - nothing is signalled until the holder is confirmed to be this root's
 *     daemon, from the lock's own record rather than from the pid number, which
 *     the kernel reuses;
 *   - nothing the holder leaves behind is removed until the process is
 *     confirmed gone. A socket file removed early is the path the still-live
 *     daemon would answer on; a lock file cleared early is a singleton with two
 *     daemons in it.
 *
 * Every holder here is a real process taking the real lock, because the state
 * cannot be staged any other way: the row inside a held lock is unreadable, and
 * that unreadability is the evidence being acted on.
 */

function stateRoot(prefix: string): Paths {
  return Paths.withRoot(shortStateRoot(prefix));
}

interface Holder {
  process: ChildProcess;
  pid: number;
}

let staged = 0;

/**
 * A process in the shape the wedged state is read from: it takes the lock,
 * writes the pid file, and then does nothing at all.
 *
 * `identity` decides what `ps` will report about it. `daemon` gives it the
 * command line every real daemon has - `daemon run --root <root>`, which is how
 * the LaunchAgent, the systemd unit and the detached spawn all invoke it - and
 * `foreign` leaves it looking like any other program, which is what a recycled
 * pid looks like.
 */
async function holderProcess(
  t: TestContext,
  paths: Paths,
  options: {
    lock?: boolean;
    pidFile?: boolean;
    ignoreTerm?: boolean;
    identity?: 'daemon' | 'foreign';
  } = {},
): Promise<Holder> {
  mkdirSync(paths.root, { recursive: true });
  staged += 1;
  const script = join(paths.root, `holder-${staged}.mjs`);
  writeFileSync(
    script,
    `import { DatabaseSync } from 'node:sqlite';
     import { writeFileSync } from 'node:fs';
     const [lockPath, pidPath, mode] = process.argv.slice(2);
     if (lockPath !== 'none') {
       const db = new DatabaseSync(lockPath);
       db.exec('PRAGMA locking_mode = EXCLUSIVE');
       db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL, started_at INTEGER NOT NULL)');
       db.exec('DELETE FROM holder');
       db.prepare('INSERT INTO holder (pid, started_at) VALUES (?, ?)').run(process.pid, Date.now());
     }
     // Exactly what the daemon does next, and the only record that can name a
     // live holder: the row itself is unreadable while the lock is held.
     if (pidPath !== 'none') writeFileSync(pidPath, process.pid + '\\n');
     if (mode === 'ignore-term') process.on('SIGTERM', () => {});
     process.stdout.write('HELD\\n');
     setInterval(() => {}, 1000);`,
  );
  const tail = (options.identity ?? 'daemon') === 'daemon' ? ['daemon', 'run', '--root', paths.root] : [];
  const child = spawn(
    process.execPath,
    [
      script,
      options.lock === false ? 'none' : paths.lockFile,
      options.pidFile === false ? 'none' : paths.pidFile,
      options.ignoreTerm ? 'ignore-term' : 'exit-on-term',
      ...tail,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()));
  const pid = child.pid as number;
  // Nothing here may outlive its test. The pipe is closed and the handle
  // unreferenced so a holder that is meant to survive the command under test -
  // every refusal is one - cannot hold the test process's event loop open, and
  // the SIGKILL is waited for so no ignore-SIGTERM holder is left running on
  // the machine after the suite.
  child.stdout?.destroy();
  child.unref();
  t.after(async () => {
    child.kill('SIGKILL');
    await waitForDeath(pid);
  });
  return { process: child, pid };
}

/** A socket file with nothing behind it, as an unclean exit leaves. */
function leaveSocketFile(paths: Paths): void {
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.socket, '');
}

async function waitForDeath(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

test('a wedged daemon is ended by SIGTERM, and only then is its debris removed', async (t) => {
  const paths = stateRoot('stop-term');
  const holder = await holderProcess(t, paths);
  leaveSocketFile(paths);

  const before = await daemonState(paths);
  assert.equal(before.diagnosis.kind, 'wedged', 'the staged state must be the one under test');

  const result = await stopDaemon(paths, { timeoutMs: 5000 });

  assert.equal(result.outcome, 'stopped');
  assert.equal(result.stopped, true);
  assert.equal(result.wasRunning, true);
  assert.equal(result.pid, holder.pid);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(await waitForDeath(holder.pid), true, 'the holder must actually be gone');

  // The cleanup, which happens only after that confirmation.
  assert.equal(existsSync(paths.socket), false, 'the socket file of a dead daemon is debris');
  assert.equal(existsSync(paths.pidFile), false, 'the pid file named the process that just ended');
  const after = await daemonState(paths);
  assert.equal(after.diagnosis.kind, 'stopped', 'the lock must read free, not stale');
  assert.equal(after.lock?.state, 'free');
});

test('a wedged daemon that ignores SIGTERM is not killed without --force, and nothing is cleaned up', async (t) => {
  const paths = stateRoot('stop-needs-force');
  const holder = await holderProcess(t, paths, { ignoreTerm: true });
  leaveSocketFile(paths);

  const result = await stopDaemon(paths, { timeoutMs: 1500 });

  assert.equal(result.outcome, 'needs-force');
  assert.equal(result.stopped, false);
  assert.equal(result.signal, 'SIGTERM');
  assert.match(result.detail ?? '', new RegExp(`pid ${holder.pid} did not exit`));
  assert.ok(
    result.help.some((line) => line.includes('--force')),
    'the sentence has to say exactly what to do next',
  );
  assert.equal(processAlive(holder.pid), true, 'SIGKILL is never sent without being asked for');
  assert.equal(existsSync(paths.socket), true, 'the socket of a live daemon is the path it answers on');
  assert.equal(existsSync(paths.pidFile), true);
  assert.equal((await daemonState(paths)).diagnosis.kind, 'wedged', 'the lock is still held');
});

test('--force escalates to SIGKILL and ends the same daemon', async (t) => {
  const paths = stateRoot('stop-force');
  const holder = await holderProcess(t, paths, { ignoreTerm: true });
  leaveSocketFile(paths);

  const result = await stopDaemon(paths, { timeoutMs: 1500, force: true });

  assert.equal(result.outcome, 'stopped');
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.pid, holder.pid);
  assert.equal(await waitForDeath(holder.pid), true);
  assert.equal(existsSync(paths.socket), false);
  assert.equal((await daemonState(paths)).diagnosis.kind, 'stopped');
});

test('a holder that is not this root\'s daemon is refused, and no signal is sent', async (t) => {
  const paths = stateRoot('stop-foreign');
  // Same lock, same pid file, a command line that is not `daemon run --root`:
  // the reading a recycled pid produces.
  const holder = await holderProcess(t, paths, { identity: 'foreign' });

  const result = await stopDaemon(paths, { timeoutMs: 1500 });

  assert.equal(result.outcome, 'refused');
  assert.equal(result.stopped, false);
  assert.equal(result.signal, null, 'a refusal sends nothing');
  assert.equal(result.pid, holder.pid);
  assert.match(result.detail ?? '', /no signal was sent/);
  await delay(300);
  assert.equal(processAlive(holder.pid), true, 'an unconfirmed process must survive the command');
  assert.equal((await daemonState(paths)).diagnosis.kind, 'wedged', 'nothing was cleaned up either');
});

test('a pid the record cannot vouch for - reused since it was written - is refused', async (t) => {
  const paths = stateRoot('stop-recycled');
  const holder = await holderProcess(t, paths);

  // The one reading a real process cannot be made to produce: a process whose
  // command line is this root's daemon, but which started long after the record
  // naming its pid was written. That is what a reused pid looks like.
  const result = await stopDaemon(paths, {
    timeoutMs: 1500,
    readProcess: () => ({
      kind: 'facts',
      commandLine: `${process.execPath} main.js daemon run --root ${paths.root}`,
      startedAt: Date.now() + 60_000,
    }),
  });

  assert.equal(result.outcome, 'refused');
  assert.match(result.detail ?? '', /reused/);
  await delay(300);
  assert.equal(processAlive(holder.pid), true, 'the process that inherited the number is not ours to end');
});

test('a lock held with no live pid recorded is refused, naming the missing record', async (t) => {
  const paths = stateRoot('stop-nopid');
  const holder = await holderProcess(t, paths, { pidFile: false });

  const result = await stopDaemon(paths, { timeoutMs: 1500 });

  assert.equal(result.outcome, 'refused');
  assert.equal(result.pid, null);
  assert.match(result.detail ?? '', new RegExp(paths.pidFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(result.help.some((line) => line.includes('service manager')));
  assert.equal(processAlive(holder.pid), true);
});

/**
 * The process ending is not proof the lock is free, and the cleanup keys on the
 * lock rather than on the kill having worked. Staged with the two facts apart:
 * the pid file names one process, and a second one holds the lock.
 */
test('a lock somebody else holds is left alone once the named process ends', async (t) => {
  const paths = stateRoot('stop-otherlock');
  const keeper = await holderProcess(t, paths, { pidFile: false });
  const named = await holderProcess(t, paths, { lock: false });
  leaveSocketFile(paths);

  const result = await stopDaemon(paths, { timeoutMs: 5000 });

  assert.equal(result.outcome, 'lock-still-held');
  assert.equal(result.stopped, false);
  assert.equal(result.pid, named.pid);
  assert.equal(await waitForDeath(named.pid), true, 'the process the record named was ended');
  assert.equal(processAlive(keeper.pid), true, 'the holder of the lock was never signalled');
  assert.equal(existsSync(paths.socket), true, 'a lock somebody holds means none of this is debris');
  assert.equal(existsSync(paths.pidFile), true);
});

test('a stale lock and a stopped root behave exactly as they did', async (t) => {
  const stale = stateRoot('stop-stale');
  const holder = await holderProcess(t, stale);
  holder.process.kill('SIGKILL');
  assert.equal(await waitForDeath(holder.pid), true);
  leaveSocketFile(stale);

  const staleResult = await stopDaemon(stale, { timeoutMs: 1500 });
  assert.equal(staleResult.outcome, 'not-running');
  assert.equal(staleResult.wasRunning, false);
  assert.equal(staleResult.signal, null);
  assert.equal(existsSync(stale.socket), false, 'a socket nothing answers on is still removed here');
  const afterStale = await daemonState(stale);
  assert.equal(afterStale.diagnosis.kind, 'stale-lock', 'the record a dead holder left is not this command to clear');

  const empty = stateRoot('stop-empty');
  const emptyResult = await stopDaemon(empty, { timeoutMs: 1500 });
  assert.equal(emptyResult.outcome, 'not-running');
  assert.equal(emptyResult.stopped, false);
  assert.equal(emptyResult.pid, null);
});

/** The command surface: the exit code and the sentence a person actually sees. */
async function cli(argv: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  let out = '';
  const writers: Writers = { out: (chunk) => (out += chunk), err: () => {} };
  const previousEnv = { ...process.env };
  delete process.env.NO_MISTAKES_GATE;
  Object.assign(process.env, env);
  try {
    return { code: await runCli(argv, writers), out };
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

test('`daemon stop` exits non-zero and names --force, and exits 0 with it', async (t) => {
  const paths = stateRoot('stop-cli');
  const holder = await holderProcess(t, paths, { ignoreTerm: true });
  const env = {
    EYES_HOME: paths.root,
    EYES_ON_SKILL_ROOT: tempDir('stop-cli-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NM_HOME: tempDir('stop-cli-nm-home'),
  };

  const refusedRun = await cli(['daemon', 'stop', '--format', 'json'], env);
  assert.equal(refusedRun.code, 1, 'a daemon that is still running is not a success');
  const refused = JSON.parse(refusedRun.out) as { daemon: string; pid: number; help: string[] };
  assert.equal(refused.pid, holder.pid);
  assert.ok(refused.help.some((line) => line.includes('--force')));
  assert.equal(processAlive(holder.pid), true);

  const forcedRun = await cli(['daemon', 'stop', '--force', '--format', 'json'], env);
  assert.equal(forcedRun.code, 0);
  const forced = JSON.parse(forcedRun.out) as { daemon: string; signal: string };
  assert.equal(forced.daemon, 'stopped');
  assert.equal(forced.signal, 'SIGKILL');
  assert.equal(await waitForDeath(holder.pid), true);
});
