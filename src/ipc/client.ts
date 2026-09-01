import { connect } from 'node:net';
import { ERROR_CODES, type JsonRpcResponse } from './protocol.js';

/** A daemon call that failed on the daemon's side. */
export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

/** The daemon is not reachable at all - not running, or a stale socket path. */
export class DaemonUnreachableError extends Error {
  constructor(endpoint: string, cause: string) {
    super(`no eyes-on daemon is listening on ${endpoint} (${cause})`);
    this.name = 'DaemonUnreachableError';
  }
}

/**
 * One request, one response, one connection. The daemon does no long-lived
 * streaming at stage 0, so a connection per call keeps the client honest about
 * liveness: if the connect fails, the daemon is genuinely not there.
 */
export function call<T = unknown>(
  endpoint: string,
  method: string,
  params: unknown = {},
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = connect(endpoint);
    let buffer = '';
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    const succeed = (value: T): void => {
      if (settled) return;
      settled = true;
      socket.end();
      resolve(value);
    };

    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => fail(new DaemonUnreachableError(endpoint, 'timed out')));
    socket.once('error', (error) => fail(new DaemonUnreachableError(endpoint, (error as Error).message)));
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(buffer.slice(0, newline)) as JsonRpcResponse;
      } catch {
        fail(new RpcError(ERROR_CODES.parseError, 'daemon sent an unparseable response'));
        return;
      }
      if (response.error) {
        fail(new RpcError(response.error.code, response.error.message));
        return;
      }
      succeed(response.result as T);
    });
  });
}
