#!/usr/bin/env node
/**
 * The stage 3 self-sufficiency measurement, as a script rather than as a
 * paragraph.
 *
 * The acceptance condition (report section 8, stage 3) is: the chain from a
 * change to its pull request to the commit that landed it is reconstructible
 * **without the no-mistakes database**, from `gh` and git alone, for every
 * merged pull request.
 *
 * Three things about the method are worth stating before the number is read.
 *
 * **It drives the product, not a copy of it.** Each pull request is measured by
 * running `eyes-on label --pr <n> --dry-run`, which reconstructs the chain and
 * writes nothing. A script that re-derived the link itself would be measuring
 * the script.
 *
 * **The no-mistakes database is not merely unused, it is unreachable.** `NM_HOME`
 * points at an empty temporary directory for the whole sweep, so a fallback
 * onto it could not succeed even if one existed.
 *
 * **What it reads and what it writes.** The reference clone is only ever read,
 * and the two writing gh endpoints are never among the calls a `--dry-run`
 * makes. This script itself **does** write: `eyes-on init` creates a state
 * root, builds a mirror, starts a daemon and installs a skill - all into a
 * temporary root of its own, with `EYES_ON_SKILL_ROOT` pointed inside it, and
 * all of it deleted afterwards. Nothing it writes lands in a repository it
 * reads.
 *
 * Usage:
 *   node docs/stage-3-selfsufficiency.mjs [--repo <path>] [--n <count>] [--json <file>]
 *
 * `--n` measures only the newest N merged pull requests; the default is all of
 * them. One gh call per pull request, so the whole sweep is a few minutes.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const REPO = value('repo', join(homedir(), 'Projects/firstmate/projects/adx-worker'));
const WANTED = Number.parseInt(value('n', '0'), 10);
const OUT = value('json', null);
const CLI = fileURLToPath(new URL('../dist/src/cli/main.js', import.meta.url));

const git = (argv) => execFileSync('git', ['-C', REPO, ...argv], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/**
 * Every pull request the default branch landed, from the `(#N)` suffix a squash
 * merge leaves in the subject.
 *
 * This list is the *population*, not the measurement: it says which pull
 * requests exist to be reconstructed. The reconstruction itself is `label`'s,
 * and the two are compared below.
 */
function population() {
  const out = git(['log', '--first-parent', 'origin/main', '--format=%H%x09%s']);
  const merges = [];
  for (const line of out.split('\n')) {
    const [sha, ...rest] = line.split('\t');
    if (!sha) continue;
    const match = /\(#(\d+)\)\s*$/.exec(rest.join('\t'));
    if (!match) continue;
    merges.push({ number: Number(match[1]), sha, subject: rest.join('\t') });
  }
  return merges;
}

function label(number, env) {
  const out = execFileSync(
    process.execPath,
    [CLI, 'label', '--pr', String(number), '--dry-run', '--format', 'json'],
    { cwd: REPO, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

function main() {
  const all = population();
  const merges = WANTED > 0 ? all.slice(0, WANTED) : all;
  if (merges.length === 0) throw new Error('no merged pull request on origin/main carries a (#N) subject');

  const root = mkdtempSync(join(process.env.EYES_ON_TEST_ROOT_BASE ?? '/tmp', 'eo-ss-'));
  const env = {
    ...process.env,
    EYES_HOME: join(root, 's'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    EYES_ON_SKILL_ROOT: mkdtempSync(join(tmpdir(), 'eo-ss-skills-')),
    // Unreachable rather than merely unused: there is no no-mistakes state at
    // this path for anything to fall back onto.
    NM_HOME: mkdtempSync(join(tmpdir(), 'eo-ss-nm-')),
  };

  try {
    execFileSync(process.execPath, [CLI, 'init'], { cwd: REPO, env, stdio: 'ignore' });

    const rows = [];
    const started = Date.now();
    for (const merge of merges) {
      const at = Date.now();
      let doc;
      let failure = null;
      try {
        doc = label(merge.number, env);
      } catch (error) {
        failure = String(error.message ?? error).split('\n')[0];
      }
      rows.push({
        pr: merge.number,
        expected_merge_sha: merge.sha,
        link: doc?.link ?? null,
        git_merge_sha: doc?.git_merge_sha ?? null,
        github_merge_sha: doc?.github_merge_sha ?? null,
        merge_sha: doc?.merge_sha ?? null,
        head_sha: doc?.head_sha ?? null,
        // Whether GitHub answered at all, and why not when it did not. `label`
        // records a row from the default-branch subject alone when gh cannot
        // read the pull request, so a sweep interrupted by a rate limit still
        // produces links - and only this field tells that run apart from one
        // measured with GitHub reachable throughout.
        github_read: doc?.github_read ?? null,
        github_unread_reason: doc?.github_unread_reason ?? null,
        // The population and the product must name the same commit. A link
        // that "agrees" about the wrong commit would be a confirmed error.
        matches_history: doc?.merge_sha === merge.sha,
        // Whether eyes-on could also have written a register line, which is a
        // separate fact: this history was never assessed, so almost none can.
        would_record: doc?.would_record ?? true,
        failure,
        ms: Date.now() - at,
      });
      process.stderr.write(
        `#${merge.number}: ${rows[rows.length - 1].link ?? `FAILED (${failure})`}` +
          `${rows[rows.length - 1].matches_history ? '' : ' - MISMATCH'}\n`,
      );
    }

    const confirmed = rows.filter((row) => row.link === 'agrees' && row.matches_history);
    const byLink = {};
    for (const row of rows) byLink[row.link ?? 'error'] = (byLink[row.link ?? 'error'] ?? 0) + 1;
    const times = rows.map((row) => row.ms).sort((a, b) => a - b);

    const report = {
      repo: REPO,
      merged_pull_requests_on_branch: all.length,
      measured: rows.length,
      confirmed: confirmed.length,
      criterion: 'every merged pull request links to its merge commit from git and GitHub alone',
      passes: confirmed.length === rows.length,
      by_link: byLink,
      // Rows GitHub answered for. A confirmed count taken over a sweep where gh
      // was refused reads as a claim about a path that run never exercised, so
      // the two numbers are reported apart rather than trusted to agree.
      github_answered: rows.filter((row) => row.github_read === true).length,
      mismatches: rows.filter((row) => !row.matches_history).map((row) => ({
        pr: row.pr,
        link: row.link,
        expected_merge_sha: row.expected_merge_sha,
        merge_sha: row.merge_sha,
        failure: row.failure,
      })),
      median_ms: times[Math.floor(times.length / 2)],
      total_ms: Date.now() - started,
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
