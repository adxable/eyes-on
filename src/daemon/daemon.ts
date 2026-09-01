import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Paths, STATE_SUBDIRS } from '../core/paths.js';
import { logPolicy } from '../core/config.js';
import { boundCaptureFile, RotatingLog } from '../core/logstore.js';
import { repoID as computeRepoID, canonicalPath } from '../core/repoid.js';
import { Database, findRepoByPath, listRepos, upsertRepo } from '../db/db.js';
import { defaultBranch } from '../git/git.js';
import { ensureMirror, inspectMirror } from '../git/mirror.js';
import { RpcServer } from '../ipc/server.js';
import {
  METHODS,
  type HealthResult,
  type NotifyCommitParams,
  type NotifyCommitResult,
  type RegisterRepoParams,
  type RegisterRepoResult,
  type StatusResult,
} from '../ipc/protocol.js';
import { SingletonLock } from './lock.js';
import { version } from '../core/version.js';

/**
 * The daemon process.
 *
 * Startup order is the contract (report M13, mirroring
 * internal/daemon/daemon.go:169-231):
 *
 *   1. create the state root,
 *   2. take the exclusive singleton lock,
 *   3. open the database and run migrations,
 *   4. only then bind the socket.
 *
 * Steps 2 and 4 in that order are what makes a second daemon impossible rather
 * than unlikely: by the time anyone could bind the socket, they have already
 * failed to take the lock.
 *
 * At stage 0 the daemon owns registration, mirrors and status. It computes no
 * risk - that is stage 1 - and it is idle when nothing asks it anything, which
 * is the answer to the captain having two auto-starting daemons (report R3).
 */
export class Daemon {
  private readonly paths: Paths;
  private readonly log: RotatingLog;
  private lock: SingletonLock | null = null;
  private db: Database | null = null;
  private server: RpcServer | null = null;
  private readonly startedAt = Date.now();
  private stopping = false;

  constructor(paths: Paths) {
    this.paths = paths;
    // `logPolicy`, not `loadConfig`: a config.yaml the user edited into
    // something that no longer parses is their file, and how many bytes a log
    // keeps is not worth refusing to start over - least of all under a service
    // manager that would then restart the daemon forever. `init` repairs it.
    this.log = new RotatingLog(paths.daemonLog, logPolicy(paths));
  }

  /** Creates the directory layout from Appendix C.2. Safe to repeat. */
  static ensureStateRoot(paths: Paths): void {
    mkdirSync(paths.root, { recursive: true });
    for (const dir of STATE_SUBDIRS) {
      mkdirSync(join(paths.root, dir), { recursive: true });
    }
  }

  async start(): Promise<void> {
    Daemon.ensureStateRoot(this.paths);
    // Lock first. Everything below this line assumes we are the only daemon.
    this.lock = SingletonLock.acquire(this.paths.lockFile);
    this.db = Database.open(this.paths.db);
    writeFileSync(this.paths.pidFile, `${process.pid}\n`, { mode: 0o644 });

    this.server = new RpcServer();
    this.registerMethods(this.server);
    await this.server.listen(this.paths.socket);
    this.log.log('daemon.started', { pid: process.pid, root: this.paths.root, version: version() });
  }

  private registerMethods(server: RpcServer): void {
    server.handle(METHODS.health, (): HealthResult => ({
      ok: true,
      pid: process.pid,
      root: this.paths.root,
      version: version(),
      startedAt: this.startedAt,
    }));

    server.handle(METHODS.status, (): StatusResult => this.status());

    server.handle(METHODS.registerRepo, (params) => this.registerRepo(params as RegisterRepoParams));

    server.handle(METHODS.refreshMirror, (params) => {
      const { workingPath } = params as RegisterRepoParams;
      return this.registerRepo({ workingPath });
    });

    server.handle(METHODS.notifyCommit, (params) => this.notifyCommit(params as NotifyCommitParams));

    server.handle(METHODS.shutdown, () => {
      // Reply first, exit after the response has been flushed, so the caller
      // sees an answer rather than a dropped connection.
      setTimeout(() => void this.stop(), 10);
      return { stopping: true };
    });
  }

  private status(): StatusResult {
    const db = this.requireDb();
    return {
      pid: process.pid,
      root: this.paths.root,
      version: version(),
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      repos: listRepos(db).map((repo) => {
        const mirror = inspectMirror(this.paths.mirrorDir(repo.id));
        return {
          id: repo.id,
          workingPath: repo.working_path,
          defaultBranch: repo.default_branch,
          mirrorRefs: mirror.refs,
          mirrorReachable: mirror.exists && mirror.alternateReachable,
        };
      }),
    };
  }

  private registerRepo(params: RegisterRepoParams): RegisterRepoResult {
    const db = this.requireDb();
    const workingPath = canonicalPath(params.workingPath);
    const existing = findRepoByPath(db, workingPath);
    const id = existing?.id ?? computeRepoID(workingPath);
    const branch = defaultBranch(workingPath);
    const row = upsertRepo(db, { id, workingPath, defaultBranch: branch });
    const mirror = ensureMirror(this.paths.mirrorDir(row.id), workingPath, { force: params.force === true });
    this.log.log('repo.registered', { repoID: row.id, workingPath, mirrorRefs: mirror.status.refs });
    return {
      repoID: row.id,
      workingPath,
      defaultBranch: row.default_branch,
      mirrorPath: mirror.status.path,
      mirrorCreated: mirror.created,
      mirrorRepaired: mirror.repaired,
      mirrorFetchMs: Math.round(mirror.fetchMs * 100) / 100,
      mirrorRefs: mirror.status.refs,
    };
  }

  /**
   * The post-commit hook's entry point. It refreshes the mirror so the new head
   * is reachable from eyes-on's own refs; computing risk from it is stage 1.
   * An unregistered clone is declined rather than silently registered - the
   * hook is not an authorisation to start tracking a repository.
   */
  private notifyCommit(params: NotifyCommitParams): NotifyCommitResult {
    const db = this.requireDb();
    const workingPath = canonicalPath(params.workingPath);
    const repo = findRepoByPath(db, workingPath);
    if (!repo) {
      this.log.log('commit.declined', { workingPath, reason: 'repository is not registered' });
      return { accepted: false, repoID: null, reason: 'repository is not registered with eyes-on' };
    }
    const mirror = ensureMirror(this.paths.mirrorDir(repo.id), workingPath);
    this.log.log('commit.observed', {
      repoID: repo.id,
      sha: params.sha ?? null,
      mirrorRefs: mirror.status.refs,
      fetchMs: Math.round(mirror.fetchMs),
    });
    return { accepted: true, repoID: repo.id };
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('daemon database is not open');
    return this.db;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log.log('daemon.stopping', { pid: process.pid });
    if (this.server) await this.server.close();
    this.server = null;
    if (this.db) this.db.close();
    this.db = null;
    rmSync(this.paths.pidFile, { force: true });
    rmSync(this.paths.socket, { force: true });
    this.log.close();
    this.lock?.release();
    this.lock = null;
  }
}

/**
 * Runs the daemon in the foreground until a stop signal arrives.
 *
 * The service manager opens `service.out.log` and `service.err.log` itself and
 * appends to them with no bound of its own, and under `KeepAlive` it reopens
 * them on every restart - including the restarts of a daemon that dies while
 * starting. So they are bounded here, before anything that can throw: a
 * malformed config.yaml, or any failure inside `Daemon`, still passes this
 * line. A failure earlier than this module's own load cannot be bounded from
 * inside the process at all, and is not.
 */
export async function runDaemon(paths: Paths): Promise<void> {
  Daemon.ensureStateRoot(paths);
  const policy = logPolicy(paths);
  for (const name of ['service.out.log', 'service.err.log']) {
    boundCaptureFile(join(paths.logsDir, name), policy);
  }
  const daemon = new Daemon(paths);
  await daemon.start();
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      void daemon.stop().then(resolve);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    process.once('beforeExit', resolve);
  });
}
