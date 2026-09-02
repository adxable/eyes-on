import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { RpcServer, SocketInUseError, probeSocket } from '../src/ipc/server.js';
import { call, DaemonUnreachableError, RpcError } from '../src/ipc/client.js';
import { ERROR_CODES } from '../src/ipc/protocol.js';
import { shortDir } from './helpers.js';

test('a request round-trips over the socket', async () => {
  const endpoint = join(shortDir(), 'socket');
  const server = new RpcServer();
  server.handle('echo', (params) => ({ got: params }));
  await server.listen(endpoint);
  try {
    assert.deepEqual(await call(endpoint, 'echo', { a: 1 }), { got: { a: 1 } });
  } finally {
    await server.close();
  }
});

/**
 * The rule that matters: a second listener must not displace the first. Without
 * it a second daemon silently steals the path and leaves the first alive but
 * unreachable - the exact failure no-mistakes fixed in
 * internal/ipc/transport_unix.go:12-30.
 */
test('binding refuses to steal a live listener', async () => {
  const endpoint = join(shortDir(), 'socket');
  const first = new RpcServer();
  first.handle('health', () => ({ ok: true }));
  await first.listen(endpoint);
  try {
    const second = new RpcServer();
    await assert.rejects(() => second.listen(endpoint), SocketInUseError);
    // The original is still the one answering.
    assert.deepEqual(await call(endpoint, 'health'), { ok: true });
  } finally {
    await first.close();
  }
});

test('a socket file that nothing answers is stale and may be rebound', async () => {
  const endpoint = join(shortDir(), 'socket');
  const first = new RpcServer();
  first.handle('health', () => ({ ok: 1 }));
  await first.listen(endpoint);
  await first.close();
  assert.equal(await probeSocket(endpoint), false);

  const second = new RpcServer();
  second.handle('health', () => ({ ok: 2 }));
  await second.listen(endpoint);
  try {
    assert.deepEqual(await call(endpoint, 'health'), { ok: 2 });
  } finally {
    await second.close();
  }
});

test('protocol errors reach the caller as typed failures', async () => {
  const endpoint = join(shortDir(), 'socket');
  const server = new RpcServer();
  server.handle('boom', () => {
    throw new Error('handler exploded');
  });
  await server.listen(endpoint);
  try {
    await assert.rejects(
      () => call(endpoint, 'nope'),
      (error: unknown) => error instanceof RpcError && error.code === ERROR_CODES.methodNotFound,
    );
    await assert.rejects(
      () => call(endpoint, 'boom'),
      (error: unknown) => error instanceof RpcError && /handler exploded/.test(error.message),
    );
  } finally {
    await server.close();
  }
});

test('a missing daemon is reported as unreachable, not as a crash', async () => {
  const endpoint = join(shortDir(), 'socket');
  await assert.rejects(() => call(endpoint, 'health', {}, 1000), DaemonUnreachableError);
});
