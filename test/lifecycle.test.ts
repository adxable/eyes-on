import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Paths } from '../src/core/paths.js';
import {
  daemonState,
  describeDaemon,
  restartDaemon,
  startDaemon,
  stopDaemon,
  type StartResult,
} from '../src/daemon/lifecycle.js';
import {
  startManagedJob,
  type CommandResult,
  type ManagedJobStart,
  type ServiceManagerProbe,
  type ServiceStatus,
} from '../src/daemon/service.js';
import { probeSocket } from '../src/ipc/server.js';
import { tempDir } from './helpers.js';

/**
 * There is one way to obtain a daemon, and it knows the service manager exists.
 *
 * This is the invariant the product has had to repair three times: a daemon
 * spawned beside a service-managed job wins the singleton lock, the managed job
 * then exits 0 on start-up and is never restarted, and the machine is left with
 * launchd holding a loaded job with no process while an unmanaged orphan serves
 * the root. `startManagedJob` is injected here so the managed branch runs
 * without registering a real LaunchAgent or systemd unit.
 */

function stateRoot(prefix: string): Paths {
  return Paths.withRoot(join(tempDir(prefix), 'eyes-on'));
}

/** A job the manager holds and starts, whose process never answers. */
function deadJob(): { start: (paths: Paths) => ManagedJobStart; calls: number } {
  const record = {
    calls: 0,
    start: (): ManagedJobStart => {
      record.calls += 1;
      return { outcome: 'started', label: 'com.example.dead', detail: null };
    },
  };
  return record;
}

test('a managed job that never comes up is a failure, not a reason to spawn', async () => {
  const paths = stateRoot('lifecycle-dead');
  const job = deadJob();

  const result = await startDaemon(paths, { timeoutMs: 400, startManagedJob: job.start });

  assert.equal(job.calls, 1, 'the managed job must be the thing that was asked');
  assert.equal(result.via, 'service');
  assert.equal(result.started, false);
  assert.equal(result.alreadyRunning, false);
  // The regression this guards: falling back to a detached spawn here is what
  // puts an unmanaged daemon beside a dead managed job.
  assert.equal(await probeSocket(paths.socket), false, 'no daemon may be spawned beside a managed job');
  assert.equal((await daemonState(paths)).running, false);
});

test('a managed job that does come up is the daemon init reports', async () => {
  const paths = stateRoot('lifecycle-managed');
  // Stands in for launchd: the service manager, not eyes-on, owns the process.
  let spawned: StartResult | null = null;
  const startManagedJob = (target: Paths): ManagedJobStart => {
    void (async () => {
      spawned = await startDaemon(target, { timeoutMs: 10_000, startManagedJob: () => notManaged });
    })();
    return { outcome: 'started', label: 'com.example.managed', detail: null };
  };
  const notManaged: ManagedJobStart = { outcome: 'unavailable', label: '', detail: 'no service' };

  try {
    const result = await startDaemon(paths, { timeoutMs: 15_000, startManagedJob });
    assert.equal(result.via, 'service');
    assert.equal(result.started, true);
    assert.ok(result.pid, 'the daemon the service manager started must be the one that answers');
    assert.equal((await daemonState(paths)).running, true);
  } finally {
    await stopDaemon(paths);
  }
  assert.ok(spawned, 'the stand-in service manager did start a daemon');
});

/**
 * `daemon restart` is the path the split was reachable through: stopping a
 * managed daemon leaves the job loaded with no process, and the start half used
 * to spawn beside it.
 */
test('restart addresses the managed job rather than spawning beside it', async () => {
  const paths = stateRoot('lifecycle-restart');
  const job = deadJob();

  // A daemon obtained the only way available with no managed job.
  const first = await startDaemon(paths, { timeoutMs: 15_000 });
  assert.equal(first.via, 'spawn');
  assert.equal(first.started, true);

  try {
    const restarted = await restartDaemon(paths, { timeoutMs: 400, startManagedJob: job.start });
    assert.equal(restarted.via, 'service', 'restart must go through the same single path');
    assert.equal(job.calls, 1);
    assert.equal(restarted.started, false);
    assert.equal(await probeSocket(paths.socket), false, 'restart must not spawn beside a managed job');
  } finally {
    await stopDaemon(paths);
  }
});

test('with no managed service for this root, the daemon is spawned directly', async () => {
  const paths = stateRoot('lifecycle-spawn');
  try {
    const result = await startDaemon(paths, { timeoutMs: 15_000 });
    assert.equal(result.via, 'spawn');
    assert.equal(result.started, true);
    assert.ok(existsSync(paths.socket));

    // A repeat call finds it and starts nothing: idempotent means "repairs what
    // is broken", not "restarts what is working".
    const again = await startDaemon(paths, { timeoutMs: 15_000 });
    assert.equal(again.via, 'already-running');
    assert.equal(again.alreadyRunning, true);
    assert.equal(again.pid, result.pid, 'a healthy daemon keeps its pid');
  } finally {
    await stopDaemon(paths);
  }
});

/**
 * The other half of the same rule. A service manager that cannot be reached
 * holds nothing a spawned daemon could orphan, so `init` on a host without one
 * - Linux with no systemd user bus, a launchd domain this session cannot
 * address - must still end with a working daemon rather than no daemon at all.
 * A unit file on disk does not change that: `installService` writes it before
 * it ever tries to load the job.
 */
test('an unreachable service manager falls back to a spawn rather than failing', async () => {
  const paths = stateRoot('lifecycle-unreachable');
  let asked = 0;
  const unreachable = (): ManagedJobStart => {
    asked += 1;
    return {
      outcome: 'unavailable',
      label: 'eyes-on-daemon-deadbeef.service',
      detail: 'the service manager would not load it: Failed to connect to bus',
    };
  };

  try {
    const result = await startDaemon(paths, { timeoutMs: 15_000, startManagedJob: unreachable });
    assert.equal(asked, 1, 'the service manager is still asked first');
    assert.equal(result.via, 'spawn', 'nothing is held, so the fallback must fall back');
    assert.equal(result.started, true);
    assert.ok(result.pid);
    assert.equal((await daemonState(paths)).running, true, 'the host must end up with a working daemon');
  } finally {
    await stopDaemon(paths);
  }
});

/**
 * A job the manager does hold and refuses to start is the opposite case: a
 * spawn there is the orphan split, so it stays a reported failure.
 */
test('a held job the manager refuses to start is a failure, not a spawn', async () => {
  const paths = stateRoot('lifecycle-refused');
  const refused = (): ManagedJobStart => ({
    outcome: 'refused',
    label: 'com.example.refused',
    detail: 'Load failed: 5: Input/output error',
  });

  const result = await startDaemon(paths, { timeoutMs: 400, startManagedJob: refused });

  assert.equal(result.via, 'service');
  assert.equal(result.started, false);
  assert.match(result.detail ?? '', /Input\/output error/, 'the reason must reach the caller');
  assert.equal(await probeSocket(paths.socket), false, 'no daemon may be spawned beside a held job');
});

/**
 * `startManagedJob` decides which of the three outcomes above applies, and it is
 * the function the previous regressions lived in. These drive it directly
 * through an injected probe, so every branch runs on any host - including the
 * one that only appears where the service manager cannot be reached.
 */
function jobStatus(overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    supported: true,
    label: 'com.example.eyes-on',
    unitPath: '/tmp/com.example.eyes-on.plist',
    installed: true,
    loaded: false,
    running: false,
    pid: null,
    ...overrides,
  };
}

function probe(
  statuses: ServiceStatus[],
  run: (command: string, argv: string[]) => CommandResult,
  platform: ServiceManagerProbe['platform'] = () => 'darwin',
): { probe: ServiceManagerProbe; commands: string[][] } {
  const commands: string[][] = [];
  let call = 0;
  return {
    commands,
    probe: {
      platform,
      inspect: () => statuses[Math.min(call++, statuses.length - 1)] as ServiceStatus,
      run: (command, argv) => {
        commands.push([command, ...argv]);
        return run(command, argv);
      },
    },
  };
}

const OK: CommandResult = { status: 0, stderr: '' };

test('a unit file the manager cannot load leaves nothing held, so a spawn is safe', () => {
  const paths = stateRoot('mgr-off');
  // The L1 case: installService wrote the unit, then the manager refused it -
  // no systemd user bus, or a launchd domain this session cannot address.
  const harness = probe([jobStatus(), jobStatus()], () => ({
    status: 1,
    stderr: 'Failed to connect to bus: No such file or directory',
  }));

  const result = startManagedJob(paths, harness.probe);

  assert.equal(result.outcome, 'unavailable', 'nothing is held, so the caller may spawn');
  assert.match(result.detail ?? '', /Failed to connect to bus/);
  assert.equal(harness.commands.length, 1, 'the manager is asked exactly once to load the job');
});

test('a job the manager holds and will not start is refused, never spawned beside', () => {
  const paths = stateRoot('mgr-no');
  const harness = probe([jobStatus({ loaded: true })], () => ({
    status: 5,
    stderr: 'Load failed: 5: Input/output error',
  }));

  const result = startManagedJob(paths, harness.probe);

  assert.equal(result.outcome, 'refused');
  assert.match(result.detail ?? '', /Input\/output error/);
});

test('a loaded job is started through the manager, running or not', () => {
  const paths = stateRoot('mgr-up');
  for (const running of [false, true]) {
    const harness = probe([jobStatus({ loaded: true, running, pid: running ? 4242 : null })], () => OK);
    const result = startManagedJob(paths, harness.probe);
    assert.equal(result.outcome, 'started', `loaded and running=${running} must start through the manager`);
    // The outcome reports what was actually asked of the manager, rather than a
    // `running` flag that can still describe a daemon told to exit a moment ago.
    assert.deepEqual(harness.commands, [['launchctl', 'kickstart', harness.commands[0]?.[2] ?? '']]);
  }
});

test('a load that fails because the manager already holds the job counts as started', () => {
  const paths = stateRoot('mgr-race');
  // Two invocations race for one root: the loser's bootstrap fails, but by then
  // the winner has loaded the job - which is what this caller wanted.
  const harness = probe([jobStatus(), jobStatus({ loaded: true })], () => ({
    status: 37,
    stderr: 'Bootstrap failed: 37: Operation already in progress',
  }));

  const result = startManagedJob(paths, harness.probe);

  assert.equal(result.outcome, 'started', 'a job the manager now holds must not send the caller to a spawn');
});

test('the linux path asks systemctl and reaches the same outcomes', () => {
  const paths = stateRoot('mgr-linux');
  const held = probe([jobStatus({ loaded: true })], () => OK, () => 'linux');
  assert.equal(startManagedJob(paths, held.probe).outcome, 'started');
  assert.deepEqual(held.commands, [['systemctl', '--user', 'start', 'com.example.eyes-on']]);

  const unreachable = probe([jobStatus(), jobStatus()], () => ({ status: 1, stderr: 'Failed to connect to bus' }), () => 'linux');
  assert.equal(startManagedJob(paths, unreachable.probe).outcome, 'unavailable');
});

/**
 * And the whole way through: the real decision logic, on a host whose manager
 * cannot be reached, must still end with a live daemon.
 */
test('a unit file with an unreachable manager still yields a working daemon', async () => {
  const paths = stateRoot('mgr-e2e');
  const harness = probe([jobStatus(), jobStatus()], () => ({ status: 1, stderr: 'Failed to connect to bus' }));

  try {
    const result = await startDaemon(paths, {
      timeoutMs: 15_000,
      startManagedJob: (target) => startManagedJob(target, harness.probe),
    });
    assert.equal(result.via, 'spawn', 'nothing is held, so the fallback must fall back');
    assert.equal(result.started, true);
    assert.equal((await daemonState(paths)).running, true, 'the host must end up with a working daemon');
  } finally {
    await stopDaemon(paths);
  }
});


/**
 * The lock answers two opposite questions with two opposite readings, and
 * reporting either as the other is worse than saying nothing: a live daemon
 * holding the lock while the socket stays silent needs stopping, and a record
 * left by a dead one is a lock nobody holds. The row inside a held lock cannot
 * be read at all - that unreadability *is* the evidence of a live holder - so
 * this drives a real second process through both states in order.
 */
test('a wedged holder and a lock a dead holder left behind are told apart', async () => {
  const paths = stateRoot('lifecycle-wedged');
  mkdirSync(paths.root, { recursive: true });
  const script = join(paths.root, 'holder.mjs');
  writeFileSync(
    script,
    `import { DatabaseSync } from 'node:sqlite';
     import { writeFileSync } from 'node:fs';
     const db = new DatabaseSync(process.argv[2]);
     db.exec('PRAGMA locking_mode = EXCLUSIVE');
     db.exec('CREATE TABLE IF NOT EXISTS holder (pid INTEGER NOT NULL, started_at INTEGER NOT NULL)');
     db.exec('DELETE FROM holder');
     db.prepare('INSERT INTO holder (pid, started_at) VALUES (?, ?)').run(process.pid, Date.now());
     // Exactly what the daemon does next, and the only record that can name a
     // live holder: the row itself is unreadable while the lock is held.
     writeFileSync(process.argv[3], process.pid + '\\n');
     process.stdout.write('HELD\\n');
     setInterval(() => {}, 1000);`,
  );
  const holder = spawn(process.execPath, [script, paths.lockFile, paths.pidFile], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()));

  try {
    const wedged = await daemonState(paths);
    assert.equal(wedged.running, false, 'nothing is listening on the socket');
    assert.equal(wedged.diagnosis.kind, 'wedged', 'a live holder must not be reported as a stopped daemon');
    assert.equal(wedged.diagnosis.kind === 'wedged' ? wedged.diagnosis.pid : null, holder.pid);
    assert.match(describeDaemon(wedged, paths.lockFile), new RegExp(`pid ${holder.pid} is alive and holds`));
  } finally {
    holder.kill('SIGKILL');
  }

  await delay(500);
  const stale = await daemonState(paths);
  assert.equal(stale.diagnosis.kind, 'stale-lock', 'a dead holder leaves a stale lock, not a live one');
  assert.equal(stale.diagnosis.kind === 'stale-lock' ? stale.diagnosis.pid : null, holder.pid);
  const message = describeDaemon(stale, paths.lockFile);
  assert.match(message, /is free/, 'the message must not claim a dead pid holds the lock');
  assert.doesNotMatch(message, /is alive/);
});

test('a root with no lock file at all is simply stopped', async () => {
  const paths = stateRoot('lifecycle-nolock');
  const state = await daemonState(paths);
  assert.equal(state.diagnosis.kind, 'stopped');
  assert.match(describeDaemon(state, paths.lockFile), /eyes-on daemon start/);
});
