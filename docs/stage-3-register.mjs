#!/usr/bin/env node
/**
 * The stage 3 register, rebuilt from a repository's own history.
 *
 * `leaks` and `calibrate` need a register, and a register is normally filled in
 * one line at a time as changes merge - which is the calendar time the report
 * budgets for stage 3 and which no test can conjure. This script builds one
 * over history instead, so the channel table and the threshold sweep can be
 * measured on real material on the day the code ships.
 *
 * **What the resulting register is, and what it is not.** For every merged pull
 * request it assesses the change *as it landed* - `check --base <parent> --head
 * <merge> --no-model` - and then labels it. Those assessments are real: the
 * risk score, the hard rules and the band are exactly what eyes-on would have
 * said. What they are not is a record of decisions anybody made. Nobody stated
 * an intent for a change that merged months ago, so no drift grade was
 * measured and S7 is zero throughout; nobody answered a gate, so a change a
 * hard rule protects is labelled parked. So the channel distribution here is
 * eyes-on's stage 1 arithmetic over this history, and the leak rates are per
 * that distribution. Read it as what the register will look like, measured on
 * real merges, and not as what a team decided.
 *
 * **What it reads and what it writes.** The reference clone is only ever read,
 * and gh is only ever read - `label` makes one GET per pull request and the two
 * writing endpoints are not among them. This script itself **does** write: it
 * runs `eyes-on init`, `check` and a real, non-dry-run `label`, all into a
 * temporary state root of its own which it deletes afterwards, with `NM_HOME`
 * pointed at an empty directory. Nothing it writes lands in a repository it
 * reads.
 *
 * Usage:
 *   node docs/stage-3-register.mjs [--repo <path>] [--n <count>] [--json <file>]
 *                                  [--window 14d] [--since 90d] [--no-gh]
 *
 * `--no-gh` skips the GitHub half of the link, which makes the sweep about four
 * times faster and leaves every row `git-only` with the merge time taken from
 * the commit that landed on the branch.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const REPO = value('repo', join(homedir(), 'Projects/firstmate/projects/adx-worker'));
const WANTED = Number.parseInt(value('n', '0'), 10);
const WINDOW = value('window', '14d');
const SINCE = value('since', '90d');
const NO_GH = flag('no-gh');
const OUT = value('json', null);
const CLI = fileURLToPath(new URL('../dist/src/cli/main.js', import.meta.url));

const git = (argv) => execFileSync('git', ['-C', REPO, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function mergedPulls() {
  const out = git(['log', '--first-parent', 'origin/main', '--format=%H%x09%P%x09%s']);
  const merges = [];
  for (const line of out.split('\n')) {
    const [sha, parents, ...rest] = line.split('\t');
    if (!sha) continue;
    const subject = rest.join('\t');
    const match = /\(#(\d+)\)\s*$/.exec(subject);
    const parent = (parents ?? '').split(' ')[0];
    if (!match || !parent) continue;
    merges.push({ number: Number(match[1]), sha, parent, subject });
  }
  return merges;
}

function eyesOn(argv, env, { json = true } = {}) {
  const out = execFileSync(process.execPath, [CLI, ...argv], {
    cwd: REPO,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return json ? JSON.parse(out) : out;
}

function main() {
  const all = mergedPulls();
  const merges = WANTED > 0 ? all.slice(0, WANTED) : all;
  if (merges.length === 0) throw new Error('no merged pull request on origin/main carries a (#N) subject');

  const root = mkdtempSync(join(process.env.EYES_ON_TEST_ROOT_BASE ?? '/tmp', 'eo-reg-'));
  const env = {
    ...process.env,
    EYES_HOME: join(root, 's'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    EYES_ON_SKILL_ROOT: mkdtempSync(join(tmpdir(), 'eo-reg-skills-')),
    NM_HOME: mkdtempSync(join(tmpdir(), 'eo-reg-nm-')),
  };
  if (NO_GH) {
    // git and nothing else, so `label` reconstructs the chain from the `(#N)`
    // subject alone rather than merely choosing not to call gh.
    const gitOnly = mkdtempSync(join(tmpdir(), 'eo-reg-path-'));
    execFileSync('ln', ['-s', execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), join(gitOnly, 'git')]);
    env.PATH = gitOnly;
  }

  try {
    execFileSync(process.execPath, [CLI, 'init'], { cwd: REPO, env, stdio: 'ignore' });

    const started = Date.now();
    const rows = [];
    for (const merge of merges) {
      const at = Date.now();
      let checked = null;
      let labelled = null;
      let failure = null;
      try {
        checked = eyesOn(
          ['check', '--base', merge.parent, '--head', merge.sha, '--no-model', '--format', 'json'],
          env,
        );
        labelled = eyesOn(['label', '--pr', String(merge.number), '--format', 'json'], env);
      } catch (error) {
        failure = String(error.message ?? error).split('\n')[0];
      }
      rows.push({
        pr: merge.number,
        merge: merge.sha,
        score: checked?.score ?? null,
        score_max: checked?.score_max ?? null,
        band: checked?.band ?? null,
        band_from: checked?.band_from ?? null,
        gate: checked?.gate ?? null,
        link: labelled?.link ?? null,
        failure,
        ms: Date.now() - at,
      });
      process.stderr.write(
        `#${merge.number}: ${rows[rows.length - 1].band ?? `FAILED (${failure})`} ${rows[rows.length - 1].score ?? ''}` +
          ` (${rows[rows.length - 1].link ?? '-'})\n`,
      );
    }
    const built = Date.now() - started;

    const leaks = eyesOn(['leaks', '--window', WINDOW, '--since', SINCE, '--format', 'json'], env);
    const calibrate = eyesOn(['calibrate', '--window', WINDOW, '--since', SINCE, '--format', 'json'], env);

    const bands = {};
    for (const row of rows) bands[row.band ?? 'failed'] = (bands[row.band ?? 'failed'] ?? 0) + 1;
    const links = {};
    for (const row of rows) links[row.link ?? 'failed'] = (links[row.link ?? 'failed'] ?? 0) + 1;

    const report = {
      repo: REPO,
      merged_pull_requests_on_branch: all.length,
      registered: rows.filter((row) => row.failure === null).length,
      failed: rows.filter((row) => row.failure !== null),
      bands,
      links,
      build_ms: built,
      median_ms: rows.map((row) => row.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
      // Verbatim, so the document quotes what the command answered rather than
      // a rearrangement of it.
      leaks,
      calibrate,
      rows,
    };
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (OUT) writeFileSync(OUT, text);
    else console.log(text.trimEnd());
  } finally {
    execFileSync(process.execPath, [CLI, 'daemon', 'stop'], { cwd: REPO, env, stdio: 'ignore' });
    rmSync(root, { recursive: true, force: true });
  }
}

main();
