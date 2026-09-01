import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Paths } from '../src/core/paths.js';
import {
  daemonState,
  restartDaemon,
  startDaemon,
  stopDaemon,
  type StartResult,
} from '../src/daemon/lifecycle.js';
import { type ManagedJobStart } from '../src/daemon/service.js';
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
