import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { captureCli, sandboxEnv, stubGh, tempRepo, type TempRepo } from './helpers.js';
import { EXIT_OK } from '../src/cli/output.js';
import { GitError } from '../src/git/git.js';
import { GhError } from '../src/gh/gh.js';
import { signalDetail, spawnFailureKindOf, spawnFailureOf, MAX_OUTPUT_BYTES } from '../src/core/spawn.js';

/**
 * The size condition.
 *
 * `spawnSync` reports a program that is not installed and a program that ran
 * and wrote more than `maxBuffer` identically - `error` set, `status` null - and
 * Node's default buffer is 1 MiB, which a branch diff and a busy pull request's
 * comment listing both cross on their own. Reading them as absence produced a
 * diagnostic naming a state the machine was not in, with a remedy - install git
 * - that cannot work when git is installed and just ran.
 *
 * Two things are asserted here and they are different claims:
 *
 *   - **the reads this product makes are not capped at 1 MiB.** A diff and a
 *     listing are built past that boundary and the commands complete;
 *   - **an output that genuinely does not fit is classified as the size
 *     condition**, from a real `ENOBUFS` produced by a real overflowing
 *     subprocess, and neither its sentence nor its help claims anything is
 *     missing.
 */

const SLUG = 'acme/widgets';
const PR = 7;

/** Enough distinct lines that the resulting patch is comfortably past 1 MiB. */
function bigFile(lines: number, salt: string): string {
  return `${Array.from({ length: lines }, (_, index) => `export const ${salt}${index} = ${index}; // ${salt.repeat(4)}`).join('\n')}\n`;
}

async function initRepo(t: TestContext, repo: TempRepo, env: Record<string, string>): Promise<void> {
  await captureCli(['init'], { cwd: repo.path, env });
  t.after(async () => {
    await captureCli(['daemon', 'stop'], { cwd: repo.path, env });
  });
}

test('a branch diff past the default 1 MiB buffer is ranked, not reported as a missing git', async (t) => {
  const repo = tempRepo('spawn-bigdiff');
  repo.commitFiles('chore: configure eyes-on', {
    '.eyes-on.yml': 'schema: eyes-on/v1\n',
    'src/small.ts': 'export const small = 1;\n',
  });
  repo.git(['checkout', '-q', '-b', 'work']);
  // ~1.7 MiB of added lines: over the 1 MiB default and far under the ceiling.
  repo.commitFiles('feat: a very large change', {
    'src/generated.ts': bigFile(24_000, 'alpha'),
    'src/small.ts': 'export const small = 2;\n',
  });

  const patchBytes = Buffer.byteLength(repo.git(['diff', '--no-color', 'main..work']), 'utf8');
  assert.ok(patchBytes > 1024 * 1024, `the fixture must cross the 1 MiB default, was ${patchBytes} bytes`);
  assert.ok(patchBytes < MAX_OUTPUT_BYTES, 'and stay under the ceiling eyes-on reads at');

  const env = sandboxEnv('spawn-bigdiff');
  await initRepo(t, repo, env);

  const result = await captureCli(['spotlight', '--no-model', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as { stage: number; exit_code: number; spotlight: unknown[] };
  assert.equal(result.code, EXIT_OK, `spotlight failed on a large diff: ${result.err}`);
  assert.equal(doc.stage, 1, 'the emergency path still answers on a change this size');
  assert.ok(doc.spotlight.length > 0);
  assert.doesNotMatch(result.err, /could not be executed/);
});

test('a comment listing past the default 1 MiB buffer is read, not reported as a missing gh', async (t) => {
  const repo = tempRepo('spawn-bigpr');
  repo.commitFiles('chore: configure eyes-on', { '.eyes-on.yml': 'schema: eyes-on/v1\n', 'src/a.ts': 'export const a = 1;\n' });
  repo.git(['checkout', '-q', '-b', 'work']);
  repo.commitFiles('feat: change one thing', { 'src/a.ts': 'export const a = 2;\n' });
  const head = repo.git(['rev-parse', 'HEAD']).trim();

  // Forty comments of forty kilobytes: about 1.6 MiB of JSON once `gh api
  // --paginate` has written them all, which is what a long-running pull request
  // looks like.
  const comments = Array.from({ length: 40 }, (_, index) => ({
    id: 500 + index,
    body: `review round ${index}\n${'x'.repeat(40_000)}`,
  }));
  const gh = stubGh('spawn-bigpr', { slug: SLUG, number: PR, headSHA: head, body: '## Summary\n', comments });
  const env: Record<string, string> = { ...sandboxEnv('spawn-bigpr'), PATH: gh.path };
  await initRepo(t, repo, env);

  await captureCli(['check', '--no-model', '--format', 'json'], { cwd: repo.path, env });
  const result = await captureCli(['comment', '--pr', String(PR), '--dry-run', '--format', 'json'], {
    cwd: repo.path,
    env,
  });
  const doc = JSON.parse(result.out) as { comments_on_pr: number; eyes_on_comments_found: number; exit_code: number };
  assert.equal(result.code, EXIT_OK, `comment failed on a busy pull request: ${result.err}`);
  assert.equal(doc.comments_on_pr, comments.length, 'every page was read, not the first megabyte of them');
  assert.equal(doc.eyes_on_comments_found, 0);
  assert.doesNotMatch(result.err, /could not be executed/);
});

test('an output that does not fit is the size condition, and no remedy claims the program is missing', () => {
  // A real overflow, not a hand-made error object: a subprocess writing 2 MiB
  // under a 1 MiB buffer is exactly the shape `git diff` and `gh api --paginate`
  // arrive in.
  const overflowed = spawnSync(process.execPath, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  assert.ok(overflowed.error, 'the fixture must actually overflow');
  assert.equal(overflowed.status, null, 'and produce no status, exactly like an absent program');
  assert.equal(spawnFailureKindOf(overflowed.error), 'output-too-large');

  const tooLarge = new GitError(['diff', 'a..b'], -1, String(overflowed.error?.message), 'output-too-large');
  assert.match(tooLarge.message, /produced more than .* of output/);
  assert.doesNotMatch(tooLarge.message, /could not be executed/);
  assert.ok(
    tooLarge.help.every((line) => !/^Install /.test(line)),
    'installing git cannot fix a git that ran',
  );
  assert.ok(tooLarge.help.some((line) => line.includes('installed and ran')));
  assert.ok(tooLarge.help.some((line) => line.includes('--base')), 'the remedy has to be one the caller can act on');

  const ghTooLarge = GhError.spawnFailed('output-too-large', String(overflowed.error?.message));
  assert.match(ghTooLarge.message, /gh ran and produced more than/);
  assert.ok(ghTooLarge.help.every((line) => !/^Install /.test(line)));
  assert.equal(ghTooLarge.status, null, 'a call with no exit status carries none, not a sentinel');

  // And absence is still absence, with the remedy that does work in it.
  const absent = spawnSync('eyes-on-no-such-program', [], { encoding: 'utf8' });
  assert.equal(spawnFailureKindOf(absent.error), 'missing');
  const missing = new GitError(['version'], -1, String(absent.error?.message), 'missing');
  assert.match(missing.message, /git could not be executed/);
  assert.ok(missing.help.some((line) => line === 'Install git and make sure it is on PATH'));

  // A program that ran and was killed for taking too long is a third state, and
  // it is not absence either.
  const slow = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { encoding: 'utf8', timeout: 200 });
  assert.equal(spawnFailureKindOf(slow.error), 'timeout');
  const timedOut = new GitError(['log'], -1, String(slow.error?.message), 'timeout');
  assert.match(timedOut.message, /stopped for taking too long/);
  assert.ok(timedOut.help.every((line) => !/^Install /.test(line)));
});

test('a subprocess killed from outside is a fourth state, and it sets no error at all', () => {
  // The one `spawnSync` reports with `error` unset: a classifier reading only
  // the error sees a success-shaped result with no status and has to invent
  // one. Reading the whole result is what makes the branches exhaustive.
  const killed = spawnSync(process.execPath, ['-e', "process.kill(process.pid, 'SIGKILL')"], { encoding: 'utf8' });
  assert.equal(killed.error, undefined, 'this is the shape the old classifier could not see');
  assert.equal(killed.status, null);
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(spawnFailureOf(killed), 'signalled');

  // And a process that ran and exited is not a failure at all, whatever it
  // exited with.
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(3)'], { encoding: 'utf8' });
  assert.equal(spawnFailureOf(exited), null, 'an exit status is an answer, not a failure to classify');

  const ghKilled = GhError.spawnFailed('signalled', signalDetail(killed));
  assert.match(ghKilled.message, /gh ran and was killed by SIGKILL/);
  assert.equal(ghKilled.kind, 'spawn');
  assert.ok(ghKilled.help.length > 0, 'the dispatcher renders help, so an empty one is reported as a bug');
  assert.ok(ghKilled.help.every((line) => !/^Install /.test(line)));

  // The state it used to be confused with, which really is a defect in eyes-on
  // and really does carry no remedy.
  const refused = GhError.refused('refusing to run "gh pr merge 1"');
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.help.length, 0);
  assert.notEqual(refused.kind, ghKilled.kind, 'the two no longer share a sentinel');
});
