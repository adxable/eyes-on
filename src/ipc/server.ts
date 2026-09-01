import { createServer, connect, type Server, type Socket } from 'node:net';
import { mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { ERROR_CODES, isJsonRpcRequest, type JsonRpcResponse } from './protocol.js';

/**
 * A JSON-RPC listener on a unix domain socket that refuses to steal a live one.
 *
 * The rule is copied deliberately from internal/ipc/transport_unix.go:12-30:
 * before binding, dial the path. If something answers, a live daemon already
 * owns it and listen fails, rather than unlinking the path out from under a
 * process that is still running and leaving it alive but unreachable. Only a
 * path that provably answers nothing - a leftover from an unclean exit - is
 * removed before binding.
 *
 * eyes-on needs this for its own sake and for the captain's: two daemons on one
 * root is two of everything, and the failure is silent.
 */

export type MethodHandler = (params: unknown) => Promise<unknown> | unknown;

export class SocketInUseError extends Error {
  constructor(endpoint: string) {
    super(`ipc socket ${endpoint} is already in use by a live listener`);
    this.name = 'SocketInUseError';
  }
}

/** Resolves true when something is listening on endpoint right now. */
export function probeSocket(endpoint: string, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(endpoint);
    const finish = (alive: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export class RpcServer {
  private readonly handlers = new Map<string, MethodHandler>();
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  handle(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  /** Binds the socket, refusing to displace a live listener. */
  async listen(endpoint: string): Promise<void> {
    if (await probeSocket(endpoint)) {
      throw new SocketInUseError(endpoint);
    }
    // 0700 matters for a socket that had to move out of the state root: the
    // directory is what stops another user from taking the address first, and
    // `assertPrivateSocketDir` refuses to use one that is anything else. A
    // directory that already exists keeps whatever mode it has.
    mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
    try {
      unlinkSync(endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // The socket is owner-only: it is a control channel for one user's daemon.
    const previousMask = process.umask(0o077);
    try {
      this.server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        const server = this.server as Server;
        server.once('error', reject);
        server.listen(endpoint, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } finally {
      process.umask(previousMask);
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void this.dispatch(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.sockets.delete(socket));
  }

  private async dispatch(socket: Socket, line: string): Promise<void> {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.reply(socket, { jsonrpc: '2.0', id: null, error: { code: ERROR_CODES.parseError, message: 'invalid JSON' } });
      return;
    }
    if (!isJsonRpcRequest(parsed)) {
      this.reply(socket, {
        jsonrpc: '2.0',
        id: null,
        error: { code: ERROR_CODES.invalidRequest, message: 'not a JSON-RPC 2.0 request' },
      });
      return;
    }
    const id = parsed.id ?? null;
    const handler = this.handlers.get(parsed.method);
    if (!handler) {
      this.reply(socket, {
        jsonrpc: '2.0',
        id,
        error: { code: ERROR_CODES.methodNotFound, message: `unknown method ${parsed.method}` },
      });
      return;
    }
    try {
      const result = await handler(parsed.params);
      this.reply(socket, { jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      this.reply(socket, {
        jsonrpc: '2.0',
        id,
        error: { code: ERROR_CODES.internal, message: (error as Error).message ?? 'internal error' },
      });
    }
  }

  private reply(socket: Socket, response: JsonRpcResponse): void {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(response)}\n`);
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
