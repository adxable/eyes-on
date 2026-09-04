#!/usr/bin/env node
/**
 * The stage 2 locality measurement, as a script rather than as a paragraph.
 *
 * The acceptance condition (report section 8, stage 2) is: for the last twenty
 * merged pull requests, the spotlight's three to five fragments land in a file
 * where the no-mistakes reviewer actually reported something, in at least 40%
 * of cases.
 *
 * Two things about the method are worth stating before the numbers are read.
 *
 * **The comparison is a proxy, not a ground truth.** A no-mistakes finding is
 * where one reviewer looked and had something to say; it is not the list of
 * everything worth reading in that change. So a spotlight fragment in a file
 * with no finding is not necessarily a miss, and the number below is a measure
 * of agreement with a reviewer rather than of correctness.
 *
 * **Everything it touches is read-only.** The no-mistakes database is opened
 * through `?mode=ro`, the reference clone is only ever read, and eyes-on runs
 * against a temporary state root that is deleted afterwards.
 *
 * Usage:
 *   node docs/stage-2-locality.mjs [--model] [--n 20] [--repo <path>]
 *
 * With `--model` the second stage runs for real, which is twenty calls to the
 * configured local agent. Without it the measurement is stage one alone, which
 * is deterministic and is the number the emergency path has to clear.
 */
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
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
const WANTED = Number.parseInt(value('n', '20'), 10);
const USE_MODEL = flag('model');
const NM_DB = join(process.env.NM_HOME ?? join(homedir(), '.no-mistakes'), 'state.sqlite');
const CLI = fileURLToPath(new URL('../dist/src/cli/main.js', import.meta.url));

/** Files a no-mistakes reviewer anchored a finding to, per pull request. */
function findingsByPr() {
  const db = new DatabaseSync(`file:${NM_DB}?mode=ro`, { readOnly: true });
  const repo = db
    .prepare('SELECT id FROM repos WHERE working_path = ?')
    .get(REPO);
  if (!repo) throw new Error(`no-mistakes has no repository at ${REPO}`);
  const rows = db
    .prepare(
      `SELECT r.pr_url AS url, s.findings_json AS payload
         FROM step_results s JOIN runs r ON r.id = s.run_id
        WHERE r.repo_id = ? AND r.pr_url IS NOT NULL AND s.findings_json IS NOT NULL`,
    )
    .all(repo.id);
  db.close();

  const byPr = new Map();
  let total = 0;
  for (const row of rows) {
    const match = /\/pull\/(\d+)$/.exec(row.url ?? '');
    if (!match) continue;
    let parsed;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      continue;
    }
    for (const finding of parsed.findings ?? []) {
      if (typeof finding.file !== 'string' || finding.file.trim().length === 0) continue;
      const number = Number(match[1]);
      if (!byPr.has(number)) byPr.set(number, new Set());
      byPr.get(number).add(finding.file.trim());
      total += 1;
    }
  }
  return { byPr, total };
}

const git = (args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });

/** Merged pull requests on the default branch, newest first, from the `(#N)`
 *  suffix a squash merge leaves in the subject. */
function mergedPulls() {
  const out = git(['log', '--first-parent', 'origin/main', '--format=%H%x09%P%x09%s', '-n', '400']);
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

function spotlight(base, head, env) {
  const argv = ['spotlight', '--base', base, '--head', head, '--format', 'json'];
  if (!USE_MODEL) argv.push('--no-model');
  const out = execFileSync(process.execPath, [CLI, ...argv], {
    cwd: REPO,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function main() {
  const { byPr, total } = findingsByPr();
  const candidates = mergedPulls().filter((merge) => byPr.has(merge.number)).slice(0, WANTED);
  if (candidates.length === 0) throw new Error('no merged pull request carries an anchored finding');

  const root = mkdtempSync(join(process.env.EYES_ON_TEST_ROOT_BASE ?? '/tmp', 'eo-loc-'));
  const env = {
    ...process.env,
    EYES_HOME: join(root, 's'),
    EYES_ON_SKIP_SERVICE_MANAGER: '1',
    EYES_ON_SKILL_ROOT: mkdtempSync(join(tmpdir(), 'eo-loc-skills-')),
  };

  try {
    execFileSync(process.execPath, [CLI, 'init'], { cwd: REPO, env, stdio: 'ignore' });

    const rows = [];
    for (const merge of candidates) {
      const started = Date.now();
      const doc = spotlight(merge.parent, merge.sha, env);
      const reviewed = byPr.get(merge.number);
      const files = [...new Set(doc.spotlight.map((spot) => spot.file))];
      const hits = files.filter((file) => reviewed.has(file));
      rows.push({
        pr: merge.number,
        stage: doc.stage,
        fragments: doc.spotlight.length,
        files: files.length,
        reviewed: reviewed.size,
        hit: hits.length > 0,
        hitFiles: hits,
        candidates: doc.candidates_considered,
        candidate_files: new Set(doc.candidates.map((candidate) => candidate.file)).size,
        // Recorded so the claim that the second stage never comes back with a
        // style remark is a count rather than an impression. A category outside
        // the taxonomy arrives as null, so `null` here means the model named one
        // eyes-on does not recognise - or that stage one chose the fragment.
        categories: doc.spotlight.map((spot) => spot.category),
        ms: Date.now() - started,
      });
      process.stderr.write(
        `#${merge.number}: ${doc.spotlight.length} fragments in ${files.length} files, reviewer touched ${reviewed.size} - ${hits.length > 0 ? 'HIT' : 'miss'}\n`,
      );
    }

    const hit = rows.filter((row) => row.hit).length;
    const rate = (hit / rows.length) * 100;
    console.log(
      JSON.stringify(
        {
          mode: USE_MODEL ? 'stage 2 (model)' : 'stage 1 (--no-model)',
          repo: REPO,
          anchored_findings_in_database: total,
          pull_requests: rows.length,
          hits: hit,
          hit_rate_percent: Math.round(rate * 10) / 10,
          criterion_percent: 40,
          passes: rate >= 40,
          median_ms: rows.map((row) => row.ms).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
          rows,
        },
        null,
        2,
      ),
    );
  } finally {
    execFileSync(process.execPath, [CLI, 'daemon', 'stop'], { cwd: REPO, env, stdio: 'ignore' });
    rmSync(root, { recursive: true, force: true });
  }
}

main();
