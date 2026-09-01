import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ForeignStateRootError,
  MAX_SOCKET_PATH_BYTES,
  Paths,
  SocketDirectoryError,
  assertPrivateSocketDir,
  isInsideStateRoot,
  privateSocketDirName,
} from '../src/core/paths.js';
import { tempDir } from './helpers.js';

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

/**
 * Containment, not a comparison of two named files: `~/.no-mistakes/eyes-on`
 * would put every eyes-on write - config, database, mirrors, logs, socket -
 * under a root this product may never write into, whatever the files are
 * called and however deep the nesting is.
 */
test('a state root inside the no-mistakes state root is refused, at any depth', () => {
  const nmHome = '/tmp/eyes-on-foreign-home';
  const env = { NM_HOME: nmHome } as NodeJS.ProcessEnv;
  for (const root of [nmHome, `${nmHome}/eyes-on`, `${nmHome}/a/b/c/eyes-on`, `${nmHome}/./eyes-on`]) {
    assert.throws(() => Paths.withRoot(root, env), ForeignStateRootError, `${root} must be refused`);
  }
  assert.throws(
    () => Paths.fromEnv({ NM_HOME: nmHome, EYES_HOME: `${nmHome}/eyes-on` } as NodeJS.ProcessEnv),
    /never writes anything under it/,
  );

  // A sibling, and a root whose path merely starts with the same characters,
  // are both fine: containment is by path component, not by prefix.
  assert.doesNotThrow(() => Paths.withRoot('/tmp/eyes-on-root', env));
  assert.doesNotThrow(() => Paths.withRoot(`${nmHome}-elsewhere/eyes-on`, env));
  assert.equal(isInsideStateRoot(`${nmHome}-elsewhere`, nmHome), false);
});

test('the refusal says how to choose a different root', () => {
  try {
    Paths.withRoot('/tmp/eyes-on-foreign-home/eyes-on', { NM_HOME: '/tmp/eyes-on-foreign-home' } as NodeJS.ProcessEnv);
    assert.fail('the nested root must be refused');
  } catch (error) {
    assert.ok(error instanceof ForeignStateRootError);
    assert.ok(error.help.some((line) => line.includes('EYES_HOME')), 'the help must name the variable to change');
  }
});

test('a state root too deep for a unix socket gets a short, root-specific address', () => {
  // A unix socket address is truncated rather than refused past the kernel's
  // field size, so two deep roots sharing a long prefix would otherwise bind
  // and connect to the same address - and `init` under one would register into
  // the other. Measured on a scratch root 147 bytes deep.
  const deep = `/private/tmp/claude-501/-Users-adix--treehouse-eyes-on-0a25-1-eyes-on/${'f'.repeat(36)}/scratchpad`;
  const a = Paths.withRoot(join(deep, 'acceptance', 'eyes-home'), { NM_HOME: '/nm' } as NodeJS.ProcessEnv);
  const b = Paths.withRoot(join(deep, 'probe', 'B'), { NM_HOME: '/nm' } as NodeJS.ProcessEnv);

  assert.ok(Buffer.byteLength(join(a.root, 'socket')) > MAX_SOCKET_PATH_BYTES, 'the direct address would not fit');
  assert.equal(a.socketIsOutsideRoot, true);
  assert.equal(b.socketIsOutsideRoot, true);
  assert.ok(Buffer.byteLength(a.socket) <= MAX_SOCKET_PATH_BYTES);
  assert.ok(Buffer.byteLength(b.socket) <= MAX_SOCKET_PATH_BYTES);
  assert.notEqual(a.socket, b.socket, 'two roots never share one daemon');
  assert.equal(a.socket, Paths.withRoot(a.root, { NM_HOME: '/nm' } as NodeJS.ProcessEnv).socket, 'and it is stable');
  // The relocated address is derivable by anyone who knows the state root, so
  // it may not sit loose in a shared temporary directory where another user
  // could bind it first and answer every client's call.
  assert.equal(dirname(a.socket).split('/').pop(), privateSocketDirName());
  assert.equal(dirname(a.socket), dirname(b.socket), 'one private directory per user, not per root');
});

test('a socket directory another user could write into is refused, not used', () => {
  const parent = tempDir('socket-dir');

  const hostile = join(parent, 'world-writable');
  mkdirSync(hostile, { recursive: true });
  chmodSync(hostile, 0o777);
  assert.throws(() => assertPrivateSocketDir(hostile), SocketDirectoryError);

  const notADirectory = join(parent, 'a-file');
  writeFileSync(notADirectory, '');
  assert.throws(() => assertPrivateSocketDir(notADirectory), SocketDirectoryError);

  const ours = join(parent, 'private');
  mkdirSync(ours, { recursive: true });
  chmodSync(ours, 0o700);
  assert.doesNotThrow(() => assertPrivateSocketDir(ours));

  // Absent is not a fault: there is simply no daemon yet, and the server
  // creates the directory 0700 before it binds.
  assert.doesNotThrow(() => assertPrivateSocketDir(join(parent, 'absent')));
  assert.equal(privateSocketDirName().endsWith(`-${userInfo().uid}`), true);
});

test('an ordinary state root keeps its socket inside itself', () => {
  const paths = Paths.withRoot('/tmp/eyes-on-short', { NM_HOME: '/nm' } as NodeJS.ProcessEnv);
  assert.equal(paths.socket, '/tmp/eyes-on-short/socket');
  assert.equal(paths.socketIsOutsideRoot, false);
});
