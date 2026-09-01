/**
 * JSON-RPC 2.0 vocabulary spoken over the daemon socket (report M12).
 *
 * Framing is newline-delimited JSON: one request object per line, one response
 * object per line. A thin client, a daemon that does the work - the shape
 * no-mistakes uses (internal/ipc/protocol.go:12-25), kept because a socket is
 * the only way a hook, a CLI process, and a service manager can all reach one
 * live process without racing on files.
 */

export const METHODS = {
  /** Liveness and identity. The cheapest possible round trip. */
  health: 'health',
  /** Daemon-wide status: root, pid, uptime, registered repositories. */
  status: 'status',
  /** Register or repair a repository (mirror refresh included). */
  registerRepo: 'register_repo',
  /** A new commit exists in a registered clone (the post-commit hook). */
  notifyCommit: 'notify_commit',
  /** Refresh a repository's mirror from its clone. */
  refreshMirror: 'refresh_mirror',
  /** Ask the daemon to exit. */
  shutdown: 'shutdown',
} as const;

export type Method = (typeof METHODS)[keyof typeof METHODS];

export const ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface HealthResult {
  ok: true;
  pid: number;
  root: string;
  version: string;
  startedAt: number;
}

export interface StatusRepo {
  id: string;
  workingPath: string;
  defaultBranch: string;
  mirrorRefs: number;
  mirrorReachable: boolean;
}

export interface StatusResult {
  pid: number;
  root: string;
  version: string;
  startedAt: number;
  uptimeSeconds: number;
  repos: StatusRepo[];
}

export interface RegisterRepoParams {
  workingPath: string;
  force?: boolean;
}

export interface RegisterRepoResult {
  repoID: string;
  workingPath: string;
  defaultBranch: string;
  mirrorPath: string;
  mirrorCreated: boolean;
  mirrorRepaired: boolean;
  mirrorFetchMs: number;
  mirrorRefs: number;
}

export interface NotifyCommitParams {
  workingPath: string;
  sha?: string;
}

export interface NotifyCommitResult {
  accepted: boolean;
  repoID: string | null;
  reason?: string;
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<JsonRpcRequest>;
  return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string';
}
