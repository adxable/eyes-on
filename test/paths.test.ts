import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Paths } from '../src/core/paths.js';

/**
 * The layout is Appendix C.2 and it is asserted literally, because every later
 * stage and every operator instruction refers to these exact paths.
 */
test('the state root has the documented layout', () => {
  const paths = Paths.withRoot('/tmp/eyes-on-root');
  assert.equal(paths.configFile, '/tmp/eyes-on-root/config.yaml');
  assert.equal(paths.db, '/tmp/eyes-on-root/state.sqlite');
  assert.equal(paths.ledger, '/tmp/eyes-on-root/ledger.jsonl');
  assert.equal(paths.socket, '/tmp/eyes-on-root/socket');
  assert.equal(paths.lockFile, '/tmp/eyes-on-root/daemon.lock');
  assert.equal(paths.pidFile, '/tmp/eyes-on-root/daemon.pid');
  assert.equal(paths.daemonLog, '/tmp/eyes-on-root/logs/daemon.log');
  assert.equal(paths.cliLog, '/tmp/eyes-on-root/logs/cli.log');
  assert.equal(paths.mirrorDir('abc123'), '/tmp/eyes-on-root/mirrors/abc123.git');
  assert.equal(paths.reportFile('deadbeef'), '/tmp/eyes-on-root/reports/deadbeef.json');
});

test('EYES_HOME overrides the root', () => {
  assert.equal(Paths.fromEnv({ EYES_HOME: '/custom/root' } as NodeJS.ProcessEnv).root, '/custom/root');
});

/**
 * Without this guard the first test to call Paths.fromEnv() would operate on
 * the developer's real ledger. no-mistakes refuses the default root under go
 * test for the same reason (internal/paths/paths.go:19-30).
 */
test('the default root is refused under the test runner', () => {
  assert.throws(
    () => Paths.fromEnv({ NODE_TEST_CONTEXT: 'test' } as NodeJS.ProcessEnv),
    /EYES_HOME must be set/,
  );
  assert.doesNotThrow(() =>
    Paths.fromEnv({ NODE_TEST_CONTEXT: 'test', EYES_ON_ALLOW_DEFAULT_ROOT_IN_TESTS: '1' } as NodeJS.ProcessEnv),
  );
});

test('nothing in the layout escapes the root', () => {
  const root = '/tmp/eyes-on-contained';
  const paths = Paths.withRoot(root);
  for (const path of [paths.configFile, paths.db, paths.socket, paths.lockFile, paths.mirrorDir('x'), paths.reportFile('y')]) {
    assert.ok(path.startsWith(join(root, '')), `${path} escapes the state root`);
  }
});
