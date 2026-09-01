import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { run as runCli } from '../src/cli/run.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, type Writers } from '../src/cli/output.js';
import { COMMANDS } from '../src/cli/commands.js';
import { tempDir, tempRepo } from './helpers.js';

interface Captured {
  code: number;
  out: string;
  err: string;
}

/** Runs the CLI in-process with captured streams, in a chosen directory. */
async function cli(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<Captured> {
  let out = '';
  let err = '';
  const writers: Writers = { out: (chunk) => (out += chunk), err: (chunk) => (err += chunk) };
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  if (options.cwd) process.chdir(options.cwd);
  // The suite must behave identically inside and outside a no-mistakes run.
  // The pipeline stamps NO_MISTAKES_GATE=1 on every process it spawns, and
  // eyes-on refuses to mutate under it, so an inherited marker would turn every
  // init in this file into a recursion refusal. Tests that want that refusal
  // set the marker themselves through options.env.
  delete process.env.NO_MISTAKES_GATE;
  Object.assign(process.env, options.env ?? {});
  try {
    const code = await runCli(argv, writers);
    return { code, out, err };
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

/** An isolated environment: private state root, private skill bases, private
 *  no-mistakes home, no OS service registration. Nothing here touches a real
 *  installation. The private NM_HOME matters when the suite itself runs from a
 *  checkout under the real `<NM_HOME>/worktrees`: the guard would then read the
 *  test process as a pipeline descendant by working directory. Its real
 *  behaviour is covered by test/guard.test.ts and the recursion acceptance
 *  test, which point NM_HOME at a directory that does contain the cwd. */
function sandbox(): Record<string, string> {
  return {
    EYES_HOME: join(tempDir('cli-home'), 'eyes-on'),
    EYES_ON_SKILL_ROOT: tempDir('cli-skills'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NM_HOME: tempDir('cli-nm-home'),
  };
}

test('an unknown command is a usage error with help, not a crash', async () => {
  const result = await cli(['definitely-not-a-command'], { env: sandbox() });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /^error: unknown command definitely-not-a-command$/m);
  assert.match(result.err, /^help: /m);
});

test('errors in a machine format stay on stdout as error: plus help:', async () => {
  const result = await cli(['definitely-not-a-command', '--format', 'toon'], { env: sandbox() });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.out, /^error: /m);
  assert.match(result.out, /^help\[\d+\]: /m);
});

/**
 * The AXI contract: under `axi` the payload is TOON on stdout, and *every*
 * failure is part of it. Argument-level failures used to be rendered before the
 * format was known, so an agent got exit 2 with an empty stdout and nothing to
 * parse.
 */
test('an argument-level failure under axi is still TOON on stdout', async () => {
  for (const argv of [['axi', 'status', '--format'], ['axi', 'check', '--intent'], ['axi', 'status', '--format', 'xml']]) {
    const result = await cli(argv, { env: sandbox() });
    assert.equal(result.code, EXIT_USAGE, `${argv.join(' ')} should be a usage error`);
    assert.match(result.out, /^error: /m, `${argv.join(' ')} wrote nothing to stdout`);
    assert.match(result.out, /^help\[\d+\]: /m);
    assert.equal(result.err, '', `${argv.join(' ')} must not report the failure on stderr`);
  }
});

/**
 * Command names arrive from the shell, so they include whatever an agent or a
 * typo produces. A name that happens to match an Object.prototype member must
 * reach the unknown-command path like any other.
 */
test('a prototype member is an unknown command, not an internal error', async () => {
  for (const name of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    const result = await cli([name, '--format', 'toon'], { env: sandbox() });
    assert.equal(result.code, EXIT_USAGE, `${name} should be a usage error`);
    assert.match(result.out, new RegExp(`^error: unknown command ${name.replace('__', '__')}$`, 'm'));
    assert.match(result.out, /^help\[\d+\]: /m);
  }
});

test('an unimplemented command names the stage that owns it and exits 1', async () => {
  const repo = tempRepo('cli-stub');
  for (const command of COMMANDS.filter((entry) => !entry.implemented)) {
    const result = await cli([command.name, '--format', 'toon'], { cwd: repo.path, env: sandbox() });
    assert.equal(result.code, EXIT_ERROR, `${command.name} should exit 1`);
    assert.match(result.out, new RegExp(`not implemented yet: it is delivered in stage ${command.stage}`));
  }
});

test('an unknown --format is a usage error', async () => {
  const result = await cli(['status', '--format', 'xml'], { env: sandbox() });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.err, /unknown output format xml/);
});

test('init registers the repository and is idempotent', async () => {
  const repo = tempRepo('cli-init');
  const env = sandbox();

  const first = await cli(['init', '--format', 'json'], { cwd: repo.path, env });
  assert.equal(first.code, EXIT_OK);
  const firstDoc = JSON.parse(first.out) as Record<string, unknown>;
  assert.equal(firstDoc.mirror_created, true);
  assert.equal(firstDoc.daemon, 'started');

  try {
    const second = await cli(['init', '--format', 'json'], { cwd: repo.path, env });
    assert.equal(second.code, EXIT_OK);
    const secondDoc = JSON.parse(second.out) as Record<string, unknown>;
    assert.equal(secondDoc.repo_id, firstDoc.repo_id, 'the same clone keeps its id');
    assert.equal(secondDoc.mirror_created, false, 'the mirror is not rebuilt');
    assert.equal(secondDoc.daemon, 'already running', 'a second daemon is not started');
    assert.equal(secondDoc.config_written, false, 'the config is not rewritten');

    // Exactly one repository row, one mirror, one daemon.
    const status = JSON.parse((await cli(['status', '--format', 'json'], { cwd: repo.path, env })).out) as {
      repos: unknown[];
    };
    assert.equal(status.repos.length, 1);
  } finally {
    await cli(['daemon', 'stop'], { env });
  }
});

test('init repairs what is missing on the second run', async () => {
  const repo = tempRepo('cli-repair');
  const env = sandbox();
  const first = JSON.parse((await cli(['init', '--format', 'json'], { cwd: repo.path, env })).out) as {
    mirror: string;
  };
  try {
    const { rmSync } = await import('node:fs');
    rmSync(first.mirror, { recursive: true, force: true });
    await cli(['daemon', 'stop'], { env });

    const second = JSON.parse((await cli(['init', '--format', 'json'], { cwd: repo.path, env })).out) as Record<
      string,
      unknown
    >;
    assert.equal(second.mirror_created, true, 'a deleted mirror is rebuilt');
    assert.equal(second.daemon, 'started', 'a stopped daemon is restarted');
    assert.ok(existsSync(first.mirror));
  } finally {
    await cli(['daemon', 'stop'], { env });
  }
});

test('init --watch installs the hook and preserves a foreign one', async () => {
  const repo = tempRepo('cli-watch');
  const env = sandbox();
  const hooks = join(repo.path, '.git', 'hooks');
  const { writeFileSync, chmodSync } = await import('node:fs');
  writeFileSync(join(hooks, 'post-commit'), '#!/bin/sh\n# theirs\n', { mode: 0o755 });
  chmodSync(join(hooks, 'post-commit'), 0o755);

  try {
    const result = JSON.parse((await cli(['init', '--watch', '--format', 'json'], { cwd: repo.path, env })).out) as
      Record<string, unknown>;
    assert.equal(result.hook, 'preserved-foreign');
    assert.ok(readFileSync(join(hooks, 'post-commit.eyes-on-user'), 'utf8').includes('# theirs'));
  } finally {
    await cli(['daemon', 'stop'], { env });
  }
});

test('status works and doctor reports readiness without a daemon', async () => {
  const repo = tempRepo('cli-status');
  const env = sandbox();
  const status = await cli(['status', '--format', 'json'], { cwd: repo.path, env });
  assert.equal(status.code, EXIT_OK);
  const doc = JSON.parse(status.out) as Record<string, unknown>;
  assert.equal(doc.daemon, 'stopped');
  assert.equal(doc.registered, false);

  const doctor = await cli(['doctor', '--format', 'json'], { cwd: repo.path, env });
  const report = JSON.parse(doctor.out) as { checks: { check: string; status: string }[] };
  const names = report.checks.map((entry) => entry.check);
  for (const expected of ['git', 'node', 'gh', 'daemon', 'mirror', 'skill', 'no-mistakes', 'state isolation']) {
    assert.ok(names.includes(expected), `doctor does not report ${expected}`);
  }
});

test('no subcommand prints the repository state rather than a usage wall', async () => {
  const repo = tempRepo('cli-bare');
  const result = await cli([], { cwd: repo.path, env: sandbox() });
  assert.equal(result.code, EXIT_OK);
  assert.match(result.out, /# eyes-on status/);
});

test('progress goes to stderr and never into the machine payload', async () => {
  const repo = tempRepo('cli-streams');
  const env = sandbox();
  try {
    const result = await cli(['init', '--format', 'json'], { cwd: repo.path, env });
    assert.match(result.err, /eyes-on: registering /);
    // stdout must parse as JSON on its own: nothing human leaked into it.
    assert.doesNotThrow(() => JSON.parse(result.out));
  } finally {
    await cli(['daemon', 'stop'], { env });
  }
});


/**
 * `doctor` exists to report what this machine is missing, so a missing
 * toolchain is the one failure it must never propagate. Running it with a PATH
 * that contains no git reproduces the reported failure: before the probe
 * tolerated absence, the command left through the unexpected-failure path with
 * `error: git version failed (-1): spawnSync git ENOENT` and told the user to
 * run the command that had just failed.
 */
test('doctor reports a missing git and still completes its other checks', async () => {
  const repo = tempRepo('cli-nogit');
  const env = { ...sandbox(), PATH: tempDir('cli-empty-path') };

  const result = await cli(['doctor', '--format', 'json'], { cwd: repo.path, env });

  const report = JSON.parse(result.out) as {
    ok: boolean;
    checks: { check: string; status: string; detail: string }[];
    degradations: string[];
  };
  const git = report.checks.find((row) => row.check === 'git');
  assert.equal(git?.status, 'missing', 'a git that cannot be executed is reported, not thrown');
  assert.equal(report.ok, false);
  assert.ok(
    report.degradations.some((note) => note.startsWith('git is missing')),
    'the degradation written for this condition must actually be emitted',
  );
  // The rest of the report is still there: doctor answered about everything it
  // could reach without git.
  for (const expected of ['node', 'gh', 'state root', 'database', 'daemon', 'skill', 'no-mistakes', 'state isolation']) {
    assert.ok(
      report.checks.some((row) => row.check === expected),
      `doctor stopped before reporting ${expected}`,
    );
  }
});

/**
 * A `daemon.lock` that is not a lock file this version can open blocks every
 * start, and nothing in the CLI rewrites it - so the message has to name the
 * one step that works rather than reporting an eyes-on bug or suggesting
 * `daemon start`, which cannot succeed while the file is there.
 */
test('a daemon.lock that is not a usable lock file names the step that clears it', async () => {
  const repo = tempRepo('cli-badlock');
  const env = sandbox();
  const root = env.EYES_HOME as string;
  mkdirSync(root, { recursive: true });
  const lockFile = join(root, 'daemon.lock');
  writeFileSync(lockFile, 'this is not a database');

  const run = await cli(['daemon', 'run', '--root', root], { cwd: repo.path, env });
  assert.equal(run.code, EXIT_ERROR);
  assert.match(run.err, new RegExp(`error: .*${lockFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(run.err, /help: Remove .*daemon\.lock while no eyes-on daemon is running/);
  assert.doesNotMatch(run.err, /This is an eyes-on bug/, 'a file the user can remove is not a defect report');

  const status = await cli(['daemon', 'status', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(status.out) as { condition: string; help: string[] };
  assert.equal(doc.condition, 'lock-unreadable');
  assert.ok(
    doc.help.some((line) => line.includes('Remove')),
    'the help must name the removal, not a start that cannot succeed',
  );
  assert.ok(
    !doc.help.some((line) => line === 'Start it with `eyes-on daemon start`'),
    'starting is not a remedy while the file is unreadable',
  );
});


/**
 * A state root too deep for its own socket, with the per-user directory the
 * socket would relocate into already taken by something eyes-on may not use.
 *
 * TMPDIR is short and private so the relocation lands inside it rather than in
 * the shared `/tmp` fallback, and so the fixture never touches the directory a
 * real daemon on this machine would use.
 */
function refusedSocketDirectory(): { env: Record<string, string>; cleanup: () => void } {
  const shortTmp = mkdtempSync('/tmp/eo-');
  // A plain file where the directory belongs: the cheapest hostile state this
  // user can actually create, and the one `assertPrivateSocketDir` reports as
  // "is not a directory".
  writeFileSync(join(shortTmp, `eyes-on-${userInfo().uid}`), '');
  const deepRoot = join(tempDir('deep-root'), 'a'.repeat(48), 'eyes-home');
  return {
    env: { ...sandbox(), EYES_HOME: deepRoot, TMPDIR: shortTmp },
    cleanup: () => rmSync(shortTmp, { recursive: true, force: true }),
  };
}

test('a socket directory eyes-on may not use is reported as itself, with remedies that work', async () => {
  const fixture = refusedSocketDirectory();
  try {
    const result = await cli(['status'], { env: fixture.env });
    assert.equal(result.code, EXIT_ERROR);
    assert.match(result.err, /^error: the directory eyes-on would put its daemon socket in, .* is not a directory$/m);
    // The remedies the refusal carries are the only ones that work from this
    // state, so they must survive to the surface.
    assert.match(result.err, /^help: .*chmod 700/m);
    assert.match(result.err, /EYES_HOME/);
    // Neither half of the generic sentence is true here: it is not a bug, and
    // `doctor` reads the same address.
    assert.doesNotMatch(result.err, /This is an eyes-on bug/);
  } finally {
    fixture.cleanup();
  }
});

test('doctor reports a refused socket directory instead of failing on it', async () => {
  const fixture = refusedSocketDirectory();
  try {
    const result = await cli(['doctor', '--format', 'json'], { env: fixture.env });
    const doc = JSON.parse(result.out) as { ok: boolean; checks: { check: string; status: string; detail: string }[] };
    const socket = doc.checks.find((row) => row.check === 'daemon socket');
    assert.ok(socket, 'doctor completed its report rather than aborting on the socket');
    assert.equal(socket.status, 'missing');
    assert.match(socket.detail, /chmod 700|EYES_HOME/);
    assert.equal(doc.checks.find((row) => row.check === 'daemon')?.status, 'missing');
    // The rest of the report still ran: the fault is one row, not the end of it.
    assert.ok(doc.checks.some((row) => row.check === 'git'));
    assert.ok(doc.checks.some((row) => row.check === 'state isolation'));
    assert.equal(doc.ok, false);
    assert.equal(result.code, EXIT_ERROR);
  } finally {
    fixture.cleanup();
  }
});
