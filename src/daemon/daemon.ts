import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Paths, STATE_SUBDIRS } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { boundCaptureFile, RotatingLog, type LogPolicy } from '../core/logstore.js';
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
  private readonly logPolicy: LogPolicy;
  private lock: SingletonLock | null = null;
  private db: Database | null = null;
  private server: RpcServer | null = null;
  private readonly startedAt = Date.now();
  private stopping = false;

  constructor(paths: Paths) {
    this.paths = paths;
    const config = loadConfig(paths);
    this.logPolicy = { maxBytes: config.logs.max_bytes, backups: config.logs.backups };
    this.log = new RotatingLog(paths.daemonLog, this.logPolicy);
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
    // The service manager holds these two open for the life of the job and
    // appends to them without a bound of its own. Every start-up passes here,
    // including each restart of a daemon that dies on start-up, which is the
    // only case that can fill them.
    for (const name of ['service.out.log', 'service.err.log']) {
      boundCaptureFile(join(this.paths.logsDir, name), this.logPolicy);
    }
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

/** Runs the daemon in the foreground until a stop signal arrives. */
export async function runDaemon(paths: Paths): Promise<void> {
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
