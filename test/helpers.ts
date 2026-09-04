import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MAX_OUTPUT_BYTES } from '../src/core/spawn.js';

/** A temporary directory removed when the test process exits. */
export function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `eyes-on-${prefix}-`)));
  cleanups.push(dir);
  return dir;
}

/**
 * Base for temporary state roots. Deliberately NOT `os.tmpdir()`.
 *
 * A state root has to be short enough to hold its own unix socket address
 * (`MAX_SOCKET_PATH_BYTES`), and `os.tmpdir()` is not: a macOS per-user
 * temporary directory is already about fifty bytes, and a host with a deeper
 * TMPDIR would push every test root past the limit and fail the whole suite for
 * a reason that has nothing to do with the code under test. `/tmp` is mandated
 * by POSIX and is a fixed four bytes, so a root under it is short on every
 * machine. `EYES_ON_TEST_ROOT_BASE` exists for a host where `/tmp` is not
 * usable.
 */
const STATE_ROOT_BASE = process.env.EYES_ON_TEST_ROOT_BASE ?? '/tmp';

/** A short, private directory under `STATE_ROOT_BASE`, removed on exit. */
export function shortDir(): string {
  mkdirSync(STATE_ROOT_BASE, { recursive: true });
  const dir = mkdtempSync(join(STATE_ROOT_BASE, 'eo-'));
  cleanups.push(dir);
  return dir;
}

/**
 * A state root for a test, short on any machine and removed on exit.
 *
 * The root itself is not created - `init` and the daemon create it - but its
 * parent is, so the path is stable before anything writes there.
 */
export function stateRoot(leaf = 'eyes-on'): string {
  return join(shortDir(), leaf);
}

const cleanups: string[] = [];
process.on('exit', () => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

export interface TempRepo {
  path: string;
  commit: (message: string, file?: string, contents?: string) => string;
  /** A commit touching several files at once, optionally back-dated. Dates
   *  matter to every history signal, so a test that needs one says so. */
  commitFiles: (message: string, files: Record<string, string | null>, whenISO?: string) => string;
  branch: (name: string) => void;
  checkout: (name: string) => void;
  git: (args: string[]) => string;
}

/** A throwaway git repository with one commit. Never a repository owned by
 *  anybody else: every test that touches git works on one of these. */
export function tempRepo(prefix = 'repo'): TempRepo {
  const path = tempDir(prefix);
  run(path, ['init', '-q', '-b', 'main', '.']);
  run(path, ['config', 'user.email', 'test@example.invalid']);
  run(path, ['config', 'user.name', 'eyes-on tests']);
  run(path, ['config', 'commit.gpgsign', 'false']);
  const repo: TempRepo = {
    path,
    commit(message, file = 'file.txt', contents = message) {
      return repo.commitFiles(message, { [file]: contents });
    },
    commitFiles(message, files, whenISO) {
      for (const [name, contents] of Object.entries(files)) {
        const full = join(path, name);
        if (contents === null) {
          rmSync(full, { force: true });
          continue;
        }
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents.endsWith('\n') ? contents : `${contents}\n`);
      }
      run(path, ['add', '-A']);
      const env = whenISO ? { GIT_AUTHOR_DATE: whenISO, GIT_COMMITTER_DATE: whenISO } : undefined;
      run(path, ['commit', '-q', '--allow-empty', '-m', message], env);
      return run(path, ['rev-parse', 'HEAD']).trim();
    },
    branch(name) {
      run(path, ['branch', name]);
    },
    checkout(name) {
      run(path, ['checkout', '-q', name]);
    },
    git(args) {
      return run(path, args);
    },
  };
  repo.commit('seed');
  return repo;
}

export function run(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    // The same ceiling the product reads at. Node's 1 MiB default would make a
    // fixture large enough to exercise the size condition fail here first, in
    // the helper that builds it.
    maxBuffer: MAX_OUTPUT_BYTES,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** Captured stdout, stderr and exit code of one in-process CLI run. */
export interface Captured {
  code: number;
  out: string;
  err: string;
}

/**
 * Runs the CLI in-process with a private environment.
 *
 * `NO_MISTAKES_GATE` is deleted rather than merely not set: the suite itself
 * runs from a gate worktree, so an inherited value would make the recursion
 * guard read every test as a pipeline descendant and refuse.
 */
export async function captureCli(
  argv: string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<Captured> {
  const { run } = await import('../src/cli/run.js');
  let out = '';
  let err = '';
  const writers = { out: (chunk: string) => (out += chunk), err: (chunk: string) => (err += chunk) };
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  process.chdir(options.cwd);
  delete process.env.NO_MISTAKES_GATE;
  Object.assign(process.env, options.env);
  try {
    const code = await run(argv, writers);
    return { code, out, err };
  } finally {
    process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  }
}

/** A private state root, skill root and NM_HOME, so no test can reach a real one. */
export function sandboxEnv(prefix: string): Record<string, string> {
  return {
    EYES_HOME: stateRoot(),
    EYES_ON_SKILL_ROOT: tempDir(`${prefix}-skills`),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    NM_HOME: tempDir(`${prefix}-nm-home`),
  };
}

/**
 * A PATH holding git and nothing else.
 *
 * The suite needs git to build its fixtures, so "the agent is not installed"
 * cannot be tested by emptying PATH. The symlink keeps git reachable and every
 * other program out.
 */
export function pathWithGitOnly(prefix: string): string {
  const dir = tempDir(prefix);
  const git = (process.env.PATH ?? '')
    .split(delimiter)
    .map((entry) => join(entry, 'git'))
    .find((candidate) => existsSync(candidate));
  if (!git) throw new Error('the suite needs git on PATH');
  symlinkSync(git, join(dir, 'git'));
  return dir;
}

export interface StubAgent {
  /** The name `model.agent` carries to reach this stub. A bare name, so only a
   *  PATH carrying `dir` reaches it. */
  agent: string;
  /** The directory holding the stub, to put in front of a PATH. */
  dir: string;
  /** PATH with the stub in front of it. */
  path: string;
  /** Every prompt the stub was given, in order. */
  prompts(): string[];
  /** Every argument vector the stub was invoked with, as it was executed. This
   *  is how a test asserts what eyes-on ran rather than what it said it ran. */
  argv(): string[][];
  /** The working directory the stub was actually started in, once per run. A
   *  coding agent reads the configuration of wherever it starts, so this is the
   *  environment eyes-on handed it rather than the one it claimed to. */
  cwds(): string[];
  /** Whether the stub was invoked at all. The `--no-model` acceptance condition
   *  is exactly this being false. */
  called(): boolean;
}

/**
 * A fake local agent on disk.
 *
 * Named `claude` and reached **only through PATH**, both on purpose. A
 * repository picks an agent by name and eyes-on owns the argv, so a stub handed
 * over as a path - or as an argument vector - would be testing around the guard
 * rather than through it. The stub goes on PATH the way a real agent does, and
 * records the argv it was actually invoked with so a test can assert what ran.
 */
export function stubAgent(prefix: string, responses: readonly string[]): StubAgent {
  const dir = tempDir(`${prefix}-agent`);
  const script = join(dir, 'claude');
  writeFileSync(join(dir, 'responses.json'), JSON.stringify(responses));
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const log = path.join(dir, 'prompts.jsonl');
const prompt = fs.readFileSync(0, 'utf8');
const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(log, JSON.stringify(prompt) + '\\n');
fs.appendFileSync(path.join(dir, 'argv.jsonl'), JSON.stringify(process.argv.slice(1)) + '\\n');
fs.appendFileSync(path.join(dir, 'cwd.jsonl'), JSON.stringify(process.cwd()) + '\\n');
const responses = JSON.parse(fs.readFileSync(path.join(dir, 'responses.json'), 'utf8'));
process.stdout.write(String(responses[Math.min(before, responses.length - 1)] ?? ''));
`,
    { mode: 0o755 },
  );
  return {
    agent: 'claude',
    dir,
    path: `${dir}${delimiter}${process.env.PATH ?? ''}`,
    argv(): string[][] {
      try {
        return readFileSync(join(dir, 'argv.jsonl'), 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    },
    cwds(): string[] {
      try {
        return readFileSync(join(dir, 'cwd.jsonl'), 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as string);
      } catch {
        return [];
      }
    },
    prompts(): string[] {
      try {
        return readFileSync(join(dir, 'prompts.jsonl'), 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as string);
      } catch {
        return [];
      }
    },
    called(): boolean {
      return existsSync(join(dir, 'prompts.jsonl'));
    },
  };
}

export interface StubGh {
  /** PATH with the fake `gh` in front of it. */
  path: string;
  /** Every argument vector the fake `gh` was called with. */
  calls(): string[][];
  /** The comments the fake pull request holds. */
  comments(): { id: number; body: string; user?: { login: string } }[];
  /** PATH with the fake `gh` in front of it, and git behind it and nothing
   *  else. For a test that must prove eyes-on reached GitHub and no other
   *  program. */
  dir: string;
  /** The pull request body, so a test can prove it did not move. */
  body(): string;
}

/**
 * A fake `gh` holding one pull request.
 *
 * It answers only the endpoints eyes-on is allowed to call and records every
 * invocation, which is what lets a test assert the two conditions that matter:
 * the body is untouched, and there is exactly one eyes-on comment however many
 * times the command runs. It also keeps a body, so "untouched" is a comparison
 * rather than an absence of evidence.
 */
export function stubGh(
  prefix: string,
  options: {
    slug: string;
    number: number;
    /** Null makes the pulls endpoint answer 404, which is what GitHub does for
     *  an issue number: the comments listing still succeeds. */
    headSHA: string | null;
    body: string;
    /** Comments already on the pull request, from whoever put them there. */
    comments?: readonly { id: number; body: string; user?: { login: string } }[];
    /**
     * What the pull request itself answers, for the ledger's read of it.
     *
     * Absent means an open pull request that merged nothing, which is the
     * honest default: a stub that merged by default would let a test about a
     * merged change pass without ever saying so.
     */
    pull?: {
      state?: string;
      merged?: boolean;
      merged_at?: string | null;
      merge_commit_sha?: string | null;
      title?: string;
      base_ref?: string;
    };
  },
): StubGh {
  const dir = tempDir(`${prefix}-gh`);
  const store = join(dir, 'store.json');
  const seeded = (options.comments ?? []).map((comment) => ({
    html_url: `https://example.invalid/c/${comment.id}`,
    user: { login: 'somebody-else' },
    ...comment,
  }));
  const nextId = seeded.reduce((highest, comment) => Math.max(highest, comment.id + 1), 1000);
  writeFileSync(store, JSON.stringify({ ...options, comments: seeded, nextId }));
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const store = path.join(dir, 'store.json');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const state = JSON.parse(fs.readFileSync(store, 'utf8'));
const save = () => fs.writeFileSync(store, JSON.stringify(state));
// Written with a synchronous loop rather than process.stdout.write: a write
// to a pipe followed immediately by process.exit truncates, and the listing of
// a busy pull request is exactly where that shows up.
const writeAll = (text) => {
  const buffer = Buffer.from(text);
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(1, buffer, offset, buffer.length - offset);
};
const out = (value) => writeAll(JSON.stringify(value));
const method = (() => {
  const at = args.indexOf('--method');
  return at >= 0 ? args[at + 1] : 'GET';
})();
const endpoint = args.find((arg, index) => index > 0 && !arg.startsWith('-') && args[index - 1] !== '--method' && args[index - 1] !== '--jq');
if (args[0] === 'repo' && args[1] === 'view') {
  writeAll(state.slug + '\\n');
  process.exit(0);
}
if (args[0] !== 'api' || !endpoint) { process.stderr.write('unsupported: ' + args.join(' ') + '\\n'); process.exit(1); }
if (method === 'GET' && endpoint === 'repos/' + state.slug + '/pulls/' + state.number) {
  if (state.headSHA === null) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
  // Two vectors read this path: one asks for the head sha through --jq, the
  // other for the whole pull request and picks its fields out in TypeScript.
  if (args.includes('--jq')) { writeAll(state.headSHA + '\\n'); process.exit(0); }
  const pull = state.pull || {};
  out({
    number: state.number,
    state: pull.state || 'open',
    merged: pull.merged === true,
    merged_at: pull.merged_at === undefined ? null : pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha === undefined ? null : pull.merge_commit_sha,
    head: { sha: state.headSHA, ref: 'feature' },
    base: { ref: pull.base_ref || 'main' },
    title: pull.title === undefined ? 'a pull request' : pull.title,
    html_url: 'https://example.invalid/pr/' + state.number,
  });
  process.exit(0);
}
if (method === 'GET' && endpoint === 'repos/' + state.slug + '/issues/' + state.number + '/comments') {
  out(state.comments);
  process.exit(0);
}
const input = () => JSON.parse(fs.readFileSync(0, 'utf8'));
if (method === 'POST' && endpoint === 'repos/' + state.slug + '/issues/' + state.number + '/comments') {
  const comment = { id: state.nextId++, body: input().body, html_url: 'https://example.invalid/c/' + state.nextId, user: { login: 'tester' } };
  state.comments.push(comment);
  save();
  out(comment);
  process.exit(0);
}
const patch = /^repos\\/(.+)\\/issues\\/comments\\/(\\d+)$/.exec(endpoint || '');
if (method === 'PATCH' && patch) {
  const id = Number(patch[2]);
  const comment = state.comments.find((entry) => entry.id === id);
  if (!comment) { process.stderr.write('no such comment\\n'); process.exit(1); }
  comment.body = input().body;
  save();
  out(comment);
  process.exit(0);
}
process.stderr.write('unsupported: ' + method + ' ' + endpoint + '\\n');
process.exit(1);
`,
    { mode: 0o755 },
  );
  return {
    path: `${dir}:${process.env.PATH ?? ''}`,
    dir,
    calls(): string[][] {
      try {
        return readFileSync(join(dir, 'calls.jsonl'), 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    },
    comments(): { id: number; body: string; user?: { login: string } }[] {
      return (
        JSON.parse(readFileSync(store, 'utf8')) as {
          comments: { id: number; body: string; user?: { login: string } }[];
        }
      ).comments;
    },
    body(): string {
      return (JSON.parse(readFileSync(store, 'utf8')) as { body: string }).body;
    },
  };
}
