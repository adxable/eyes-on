import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { captureCli, pathWithGitOnly, sandboxEnv, stubAgent, stubGh, tempRepo, type StubGh, type TempRepo } from './helpers.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../src/cli/output.js';
import { argvFor, refusalFor, type GhOperation } from '../src/gh/gh.js';
import { linkPull, mergedPulls, pullNumberInSubject } from '../src/ledger/link.js';
import { latestPerPull, parseRecord, type LedgerRecord } from '../src/ledger/ledger.js';
import { RepoReader } from '../src/git/reader.js';

/**
 * Stage 3's register, and the acceptance condition at the heart of it.
 *
 * **Self-sufficiency**: the chain from a change to the pull request to the
 * commit that landed it is reconstructed from git and GitHub and from nothing
 * else. Every test in this file runs with `NM_HOME` pointing at an empty
 * directory - `sandboxEnv` gives it one - so there is no no-mistakes database
 * on the machine to fall back on even by accident, and the record still names
 * the merge commit.
 *
 * The measurement over the reference repository's real history is
 * `docs/stage-3-selfsufficiency.mjs`, and it drives this same command rather
 * than a reimplementation of it, so what it measures is the product.
 */

const SLUG = 'acme/widgets';

/**
 * The tip of the branch the pull request proposed.
 *
 * Deliberately not the merge commit: a squash merge produces a commit that is
 * not the branch tip, and the branch is usually deleted afterwards, so the head
 * GitHub names is a commit eyes-on may never have assessed. Making them
 * different here is what keeps the four ways `label` finds an assessment from
 * collapsing into one that happens to work.
 */
const PR_HEAD = 'e'.repeat(40);

interface LabelDoc {
  pr: number;
  dry_run: boolean;
  recorded: boolean;
  would_record?: boolean;
  would_record_blocked?: string;
  link: string;
  link_sentence: string;
  git_merge_sha: string | null;
  github_merge_sha: string | null;
  git_candidates: number;
  merge_sha: string | null;
  merge_parent_sha: string | null;
  merge_parents: number | null;
  head_sha: string | null;
  merged_at: number | null;
  github_read: boolean;
  github_unread_reason: string | null;
  check_id: string | null;
  check_source: string | null;
  score: number | null;
  score_max: number | null;
  band: string | null;
  band_from: string;
  unverified: boolean;
  hard_rules: { glob: string; file: string }[];
  hits_fingerprint: string;
  gate: string;
  decision: string | null;
  decision_reason: string | null;
  decision_covers_recorded_hits: boolean | null;
  drift: number | null;
  drift_intent: string | null;
  exit_code: number;
  help: string[];
}

/**
 * A repository shaped like one GitHub squash-merges into.
 *
 * The change lands on `main` as a single commit whose subject carries the
 * `(#N)` suffix - that suffix is the whole of the git-side link, and it is why
 * nothing has to be written into the commit or into a ref.
 */
function mergedRepo(prefix: string, options: { config?: string } = {}): { repo: TempRepo; merge: string; parent: string } {
  const repo = tempRepo(prefix);
  const parent = repo.commitFiles(
    'chore: set up',
    options.config === undefined
      ? { 'src/a.ts': 'export const a = 1;\n' }
      : { 'src/a.ts': 'export const a = 1;\n', '.eyes-on.yml': options.config },
  );
  const merge = repo.commitFiles('feat(widget): add the widget (#7)', {
    'src/widget.ts': 'export function widget(): number {\n  return 1;\n}\n',
  });
  return { repo, merge, parent };
}

async function initRepo(t: TestContext, repo: TempRepo, env: Record<string, string>): Promise<void> {
  await captureCli(['init'], { cwd: repo.path, env });
  t.after(async () => {
    await captureCli(['daemon', 'stop'], { cwd: repo.path, env });
  });
}

/** A fake GitHub that says the pull request merged as `mergeSHA`. */
function mergedGh(prefix: string, options: { headSHA?: string; mergeSHA: string | null }): StubGh {
  return stubGh(prefix, {
    slug: SLUG,
    number: 7,
    headSHA: options.headSHA ?? PR_HEAD,
    body: 'no-mistakes wrote this body.\n',
    pull: {
      state: 'closed',
      merged: true,
      merged_at: '2026-08-26T16:41:46Z',
      merge_commit_sha: options.mergeSHA,
      title: 'add the widget',
    },
  });
}

function ledgerLines(env: Record<string, string>): LedgerRecord[] {
  const path = join(env.EYES_HOME as string, 'ledger.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const record = parseRecord(line);
      assert.ok(record, `the register holds a line this build cannot read: ${line}`);
      return record;
    });
}

/* ------------------------------------------------------------------ *
 * The link, on its own.
 * ------------------------------------------------------------------ */

test('the pull request number comes from the trailing (#N) a squash merge leaves, and only from there', () => {
  assert.equal(pullNumberInSubject('feat: add the widget (#7)'), 7);
  assert.equal(pullNumberInSubject('feat: add the widget (#7)  '), 7);
  // A number mentioned in passing is not the one the merge added; only the
  // trailing parenthesised form is.
  assert.equal(pullNumberInSubject('revert #204 because it broke the build'), null);
  assert.equal(pullNumberInSubject('fix: follow up to (#12) properly (#31)'), 31);
  assert.equal(pullNumberInSubject('chore: no pull request here'), null);
  assert.equal(pullNumberInSubject('feat: (#0)'), null);
});

/**
 * The two sources are carried apart, and a disagreement produces no merge
 * commit at all. A row naming one of two contradictory commits would be blamed
 * against by `leaks`, so "eyes-on does not know which" is the honest value.
 */
test('the link records what each source said, and names no merge commit when they disagree', () => {
  const commit = { number: 7, sha: 'a'.repeat(40), parent: 'b'.repeat(40), parents: 1, subject: 'feat: x (#7)', timestamp: 1, committed: 2 };
  const pull = {
    number: 7,
    state: 'closed',
    merged: true,
    merged_at: 100,
    merge_commit_sha: 'a'.repeat(40),
    head_sha: 'c'.repeat(40),
    base_ref: 'main',
    title: 'x',
    url: null,
  };

  const agrees = linkPull({ number: 7, fromGit: [commit], fromGitHub: pull, unread: null });
  assert.equal(agrees.agreement, 'agrees');
  assert.equal(agrees.merge_sha, 'a'.repeat(40));

  const disagrees = linkPull({
    number: 7,
    fromGit: [commit],
    fromGitHub: { ...pull, merge_commit_sha: 'd'.repeat(40) },
    unread: null,
  });
  assert.equal(disagrees.agreement, 'disagrees');
  assert.equal(disagrees.merge_sha, null, 'neither sha is the answer when the two contradict each other');
  assert.match(disagrees.sentence, /disagree/);

  const gitOnly = linkPull({ number: 7, fromGit: [commit], fromGitHub: null, unread: 'gh-missing' });
  assert.equal(gitOnly.agreement, 'git-only');
  assert.equal(gitOnly.merge_sha, 'a'.repeat(40));
  assert.match(gitOnly.sentence, /GitHub CLI is not installed/);

  const githubOnly = linkPull({ number: 7, fromGit: [], fromGitHub: pull, unread: null });
  assert.equal(githubOnly.agreement, 'github-only');

  // An open pull request is a correct answer rather than a gap, and it is not
  // the same state as a merged one nobody could place.
  const open = linkPull({
    number: 7,
    fromGit: [],
    fromGitHub: { ...pull, merged: false, merged_at: null, merge_commit_sha: null, state: 'open' },
    unread: null,
  });
  assert.equal(open.agreement, 'not-merged');
  assert.equal(open.merge_sha, null);

  const neither = linkPull({ number: 7, fromGit: [], fromGitHub: null, unread: null });
  assert.equal(neither.agreement, 'neither');
});

test('the merge walk follows the first parent, so a merged branch contributes no candidate of its own', () => {
  const repo = tempRepo('link-walk');
  repo.commitFiles('chore: base', { 'a.txt': '1' });
  repo.git(['checkout', '-q', '-b', 'side']);
  // A commit on the branch whose subject looks like a merge subject. It is
  // reachable from the tip after the merge and must never be taken for the
  // commit that landed #9 on main.
  repo.commitFiles('feat: work in progress (#9)', { 'b.txt': '1' });
  repo.git(['checkout', '-q', 'main']);
  repo.git(['merge', '--no-ff', '-q', '-m', 'feat: land the side branch (#9)', 'side']);

  const reader = new RepoReader({ clonePath: repo.path, mirrorPath: join(repo.path, 'no-mirror') });
  const head = reader.resolve('main');
  assert.ok(head);
  const merges = mergedPulls(reader, head);
  assert.deepEqual(
    merges.map((merge) => merge.subject),
    ['feat: land the side branch (#9)'],
    'the branch commit is reachable but did not land anything on main',
  );
  assert.equal(merges[0]?.parents, 2, 'a true merge commit has two parents, and that is recorded');
});

/* ------------------------------------------------------------------ *
 * `label`.
 * ------------------------------------------------------------------ */

test('acceptance: the chain from change to pull request to merge commit is rebuilt from git and GitHub alone', async (t) => {
  const { repo, merge, parent } = mergedRepo('label-chain');
  const env = sandboxEnv('label-chain');
  await initRepo(t, repo, env);
  // The state root eyes-on was told to use is the only one it wrote to, and
  // NM_HOME is an empty directory: there is no no-mistakes database on this
  // machine for the chain to have come from.
  assert.deepEqual(readdirSync(env.NM_HOME as string), [], 'the no-mistakes root must be untouched and empty');

  await captureCli(['check', '--base', parent, '--head', merge, '--format', 'json'], { cwd: repo.path, env });

  const gh = mergedGh('label-chain', { mergeSHA: merge });
  const result = await captureCli(['label', '--pr', '7', '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, PATH: gh.path },
  });
  const doc = JSON.parse(result.out) as LabelDoc;

  assert.equal(result.code, EXIT_OK);
  assert.equal(doc.link, 'agrees');
  assert.equal(doc.git_merge_sha, merge, 'git named the merge commit from the (#7) subject');
  assert.equal(doc.github_merge_sha, merge, 'GitHub named the same one');
  assert.equal(doc.merge_sha, merge);
  assert.equal(doc.merge_parent_sha, parent);
  assert.equal(doc.merge_parents, 1, 'a squash merge has one parent, which is what makes blame able to name it');
  assert.equal(doc.head_sha, PR_HEAD, 'the branch tip GitHub named, which is not the commit that landed');
  assert.equal(doc.merged_at, Date.parse('2026-08-26T16:41:46Z') / 1000, 'GitHub answered, so its merge time is the one recorded');
  assert.equal(doc.recorded, true);

  const records = ledgerLines(env);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.merge_sha, merge);
  assert.equal(records[0]?.pr, 7);
  assert.equal(records[0]?.link.agreement, 'agrees');

  // Nothing but the two programs was reached: gh answered only endpoints that
  // read, and no eyes-on state outside its own root was written.
  assert.deepEqual(readdirSync(env.NM_HOME as string), []);
  for (const call of gh.calls()) {
    assert.ok(!call.includes('--method'), `label wrote through gh: ${call.join(' ')}`);
  }
});

test('the register line carries what every fact on it was recorded against', async (t) => {
  const config = `schema: eyes-on/v1
hard_rules:
  - glob: "src/widget.ts"
    why: "the only way code leaves the building"
`;
  const { repo, merge, parent } = mergedRepo('label-context', { config });
  const env = sandboxEnv('label-context');
  await initRepo(t, repo, env);

  await captureCli(['check', '--base', parent, '--head', merge, '--format', 'json'], { cwd: repo.path, env });
  await captureCli(['axi', 'respond', '--action', 'waive', '--reason', 'reviewed offline', '--by', 'captain', '--base', parent, '--head', merge], {
    cwd: repo.path,
    env,
  });

  const gh = mergedGh('label-context', { mergeSHA: merge });
  const result = await captureCli(['label', '--pr', '7', '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, PATH: gh.path },
  });
  const doc = JSON.parse(result.out) as LabelDoc;
  const record = ledgerLines(env)[0] as LedgerRecord;

  // A score with the maximum the weights it was computed under could produce.
  assert.equal(typeof doc.score, 'number');
  assert.equal(doc.score_max, record.score_max);
  assert.equal(doc.score_max, 120, 'the six history signals plus drift at 0.20');

  // A band with what set it and whether the configuration behind it was read.
  assert.equal(doc.band, 'pelna');
  assert.equal(doc.band_from, 'hard rule');
  assert.equal(doc.unverified, false);

  // A decision with the set of rule hits it answered.
  assert.equal(doc.decision, 'waive');
  assert.equal(doc.decision_reason, 'reviewed offline');
  assert.equal(doc.decision_covers_recorded_hits, true);
  assert.equal(record.decision?.hits_fingerprint, record.hits_fingerprint);
  assert.equal(record.decision?.decided_by, 'captain');
  assert.ok(record.decision?.config_sha, 'the configuration the hits came from travels with the decision');

  // The hits themselves as a list, one entry per file, never a joined string.
  assert.deepEqual(doc.hard_rules, [{ glob: 'src/widget.ts', file: 'src/widget.ts' }]);
  assert.equal(doc.gate, 'none', 'the gate was answered before the merge, and the row says so');

  // Which assessment this row is about, which cannot be re-derived from it.
  // The branch tip GitHub names was never assessed - the branch is gone after a
  // squash merge - so the assessment found is the one of the merge commit.
  assert.equal(doc.check_source, 'merge-commit');
  assert.equal(record.check_base_sha, parent);
  assert.equal(record.check_head_sha, merge);
});


/**
 * Two default-branch commits can carry one pull request number - a change
 * reverted and re-landed under a subject that kept the suffix, a cherry-pick
 * onto the default branch - and then the sha on the row is a *choice*. `leaks`
 * blames every later fix against whichever one was recorded, so the register
 * says how many there were rather than presenting the newest as the only one.
 */
test('two default-branch commits carrying one pull request number is recorded as a choice, not hidden', async (t) => {
  const { repo, merge } = mergedRepo('label-candidates');
  // Re-landed later under a subject that still ends in (#7): a second commit on
  // the default branch naming the same pull request.
  const relanded = repo.commitFiles('fix(widget): re-land the widget (#7)', {
    'src/widget.ts': 'export function widget(): number {\n  return 2;\n}\n',
  });

  const env = sandboxEnv('label-candidates');
  await initRepo(t, repo, env);
  await captureCli(['check', '--base', merge, '--head', relanded, '--format', 'json'], { cwd: repo.path, env });

  const gh = mergedGh('label-candidates', { mergeSHA: relanded });
  const result = await captureCli(['label', '--pr', '7', '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, PATH: gh.path },
  });
  const doc = JSON.parse(result.out) as LabelDoc;
  const record = ledgerLines(env)[0] as LedgerRecord;

  assert.equal(result.code, EXIT_OK);
  assert.equal(doc.merge_sha, relanded, 'the newest candidate is the one taken');
  assert.equal(doc.git_candidates, 2, 'and the payload says it was taken from two');
  assert.equal(record.link.git_candidates, 2, 'the row keeps that, because leaks blames against the sha beside it');
  assert.ok(
    doc.link_sentence.includes(merge.slice(0, 12)),
    `the other candidate is named rather than dropped: ${doc.link_sentence}`,
  );
  assert.ok(
    doc.help.some((line) => line.includes('commits on the default branch carry')),
    `the reader is told a choice was made: ${JSON.stringify(doc.help)}`,
  );

  // The ordinary case says nothing about candidates, so the sentence above is
  // information rather than noise on every row.
  const ordinary = mergedRepo('label-candidates-one');
  const otherEnv = sandboxEnv('label-candidates-one');
  await initRepo(t, ordinary.repo, otherEnv);
  await captureCli(['check', '--base', ordinary.parent, '--head', ordinary.merge, '--format', 'json'], {
    cwd: ordinary.repo.path,
    env: otherEnv,
  });
  const oneGh = mergedGh('label-candidates-one', { mergeSHA: ordinary.merge });
  const single = JSON.parse(
    (
      await captureCli(['label', '--pr', '7', '--format', 'json'], {
        cwd: ordinary.repo.path,
        env: { ...otherEnv, PATH: oneGh.path },
      })
    ).out,
  ) as LabelDoc;
  assert.equal(single.git_candidates, 1);
  assert.ok(!single.help.some((line) => line.includes('commits on the default branch carry')));
});

/**
 * The register row carries the parent count of the commit it names, whichever
 * source named it.
 *
 * On a repository that merges with `--no-ff` no default-branch subject carries
 * `(#N)`, so GitHub is the only source and the git side contributes nothing -
 * and the parent count is exactly what decides whether `leaks` can attribute
 * anything to that commit.
 */
test('a row GitHub alone placed still carries the merge commit\'s parent count', async (t) => {
  const repo = tempRepo('label-noff');
  const base = repo.commitFiles('chore: set up', { 'src/a.ts': 'export const a = 1;\n' });
  repo.git(['checkout', '-q', '-b', 'side']);
  repo.commitFiles('feat(widget): add the widget', { 'src/widget.ts': 'export const w = 1;\n' });
  repo.git(['checkout', '-q', 'main']);
  repo.git(['merge', '--no-ff', '-q', '-m', 'Merge pull request #7 from side', 'side']);
  const merge = repo.git(['rev-parse', 'HEAD']).trim();

  const env = sandboxEnv('label-noff');
  await initRepo(t, repo, env);
  await captureCli(['check', '--base', base, '--head', merge, '--format', 'json'], { cwd: repo.path, env });

  const gh = mergedGh('label-noff', { mergeSHA: merge });
  const result = await captureCli(['label', '--pr', '7', '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, PATH: gh.path },
  });
  const doc = JSON.parse(result.out) as LabelDoc;
  const record = ledgerLines(env)[0] as LedgerRecord;

  assert.equal(result.code, EXIT_OK);
  assert.equal(doc.link, 'github-only', 'no default-branch subject carries the (#7) a squash merge leaves');
  assert.equal(doc.git_merge_sha, null);
  assert.equal(doc.merge_sha, merge);
  assert.equal(doc.merge_parents, 2, 'the count comes from the commit itself when no subject named it');
  assert.equal(record.merge_parents, 2);

  // A dry run reads the same commit and reports the same count: the answer does
  // not depend on which surface asked.
  const dry = JSON.parse(
    (
      await captureCli(['label', '--pr', '7', '--dry-run', '--format', 'json'], {
        cwd: repo.path,
        env: { ...env, PATH: gh.path },
      })
    ).out,
  ) as LabelDoc;
  assert.equal(dry.merge_parents, 2);
});

/**
 * The count of candidates is a fact about the branch and is said in every
 * state. What was done with it is not: on a disagreement no merge commit is
 * recorded, `leaks` leaves the row out with `no merge commit`, and a sentence
 * saying the newest was taken and blamed against would be stronger than the
 * code.
 */
test('with two candidates and a disagreement, nothing claims the newest was taken', async (t) => {
  const { repo, merge, parent } = mergedRepo('label-candidates-split');
  const relanded = repo.commitFiles('fix(widget): re-land the widget (#7)', {
    'src/widget.ts': 'export function widget(): number {\n  return 2;\n}\n',
  });

  const env = sandboxEnv('label-candidates-split');
  await initRepo(t, repo, env);
  const check = await captureCli(['check', '--base', parent, '--head', merge, '--format', 'json'], {
    cwd: repo.path,
    env,
  });
  const checkId = (JSON.parse(check.out) as { check_id: string }).check_id;

  // GitHub names neither of the two default-branch candidates.
  const gh = mergedGh('label-candidates-split', { mergeSHA: 'f'.repeat(40) });
  const result = await captureCli(['label', '--pr', '7', '--check-id', checkId, '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, PATH: gh.path },
  });
  const doc = JSON.parse(result.out) as LabelDoc;

  assert.equal(doc.link, 'disagrees');
  assert.equal(doc.merge_sha, null);
  assert.equal(doc.git_candidates, 2, 'the count is a fact about the branch and is said whatever was recorded');
  assert.ok(doc.link_sentence.includes(relanded.slice(0, 12)) && doc.link_sentence.includes(merge.slice(0, 12)));
  assert.ok(
    !doc.link_sentence.includes('the newest was taken'),
    `nothing was taken: ${doc.link_sentence}`,
  );
  assert.match(doc.link_sentence, /no merge commit was recorded here, so none of them was chosen/);
  assert.ok(
    !doc.help.some((line) => line.includes('blames every later fix against that one')),
    `leaks excludes this row rather than blaming against it: ${JSON.stringify(doc.help)}`,
  );
  assert.ok(
    doc.help.some((line) => line.includes('no merge commit was recorded for this row')),
    `the reader is told what leaks will do with it: ${JSON.stringify(doc.help)}`,
  );
});

test('a drift grade on the register carries the intent it was measured against', async (t) => {
  const { repo, merge, parent } = mergedRepo('label-drift');
  const env = sandboxEnv('label-drift');
  await initRepo(t, repo, env);

  // No model runs here, so no grade is measured; what the row must show is
  // that it has none *and* which intent was stated, rather than a grade with
  // nothing beside it.
  await captureCli(['check', '--base', parent, '--head', merge, '--intent', 'add a widget', '--no-model', '--format', 'json'], {
    cwd: repo.path,
    env,
  });

  const gh = mergedGh('label-drift', { mergeSHA: merge });
  const result = await captureCli(['label', '--pr', '7', '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, PATH: gh.path },
  });
  const doc = JSON.parse(result.out) as LabelDoc;
  const record = ledgerLines(env)[0] as LedgerRecord;

  assert.equal(doc.drift, null, 'no model ran, so no grade was measured');
  assert.equal(record.intent, 'add a widget');
  // The grade and the intent it answers travel together, and here that pair is
  // "no grade, against this intent" - which is a different fact from "no grade,
  // because nobody said what the change was for". The sentence names which.
  assert.equal(record.drift_intent, 'add a widget');
  assert.match(
    (doc as unknown as { drift_sentence: string }).drift_sentence,
    /No drift grade for the intent "add a widget": it was not compared with this diff/,
    'the row publishes the same provenance sentence every other surface takes from one place',
  );
});

test('a measured drift grade reaches the register beside the intent it was measured against', async (t) => {
  const { repo, merge, parent } = mergedRepo('label-graded');
  const env = sandboxEnv('label-graded');
  await initRepo(t, repo, env);

  // Two passes: the first describes the diff without the intent, the second
  // compares that description with it. The stub answers both.
  const agent = stubAgent('label-graded', [
    JSON.stringify({ describes: ['The change adds a widget function returning 1.'] }),
    JSON.stringify({ drift: 3, missing_from_diff: ['tests for the widget'], unrequested_in_diff: [] }),
  ]);
  await captureCli(
    ['check', '--base', parent, '--head', merge, '--intent', 'add a widget with tests', '--format', 'json'],
    { cwd: repo.path, env: { ...env, PATH: agent.path } },
  );

  const gh = mergedGh('label-graded', { mergeSHA: merge });
  const result = await captureCli(['label', '--pr', '7', '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, PATH: gh.path },
  });
  const doc = JSON.parse(result.out) as LabelDoc;
  const record = ledgerLines(env)[0] as LedgerRecord;

  assert.equal(doc.drift, 3);
  assert.equal(doc.drift_intent, 'add a widget with tests');
  assert.equal(record.drift, 3);
  assert.equal(record.drift_intent, 'add a widget with tests');
  assert.match(
    (doc as unknown as { drift_sentence: string }).drift_sentence,
    /Drift 3\/5 is carried from an earlier measurement of this same change against the intent "add a widget with tests"/,
  );
});

test('the register is append-only: labelling twice adds a line and rewrites none', async (t) => {
  const { repo, merge, parent } = mergedRepo('label-append');
  const env = sandboxEnv('label-append');
  await initRepo(t, repo, env);
  await captureCli(['check', '--base', parent, '--head', merge, '--format', 'json'], { cwd: repo.path, env });

  const gh = mergedGh('label-append', { mergeSHA: merge });
  const path = { cwd: repo.path, env: { ...env, PATH: gh.path } };
  await captureCli(['label', '--pr', '7', '--format', 'json'], path);
  const first = readFileSync(join(env.EYES_HOME as string, 'ledger.jsonl'), 'utf8');

  const second = await captureCli(['label', '--pr', '7', '--format', 'json'], path);
  const after = readFileSync(join(env.EYES_HOME as string, 'ledger.jsonl'), 'utf8');

  assert.ok(after.startsWith(first), 'the first line is byte for byte where it was');
  assert.equal(ledgerLines(env).length, 2);
  assert.equal(latestPerPull(ledgerLines(env)).length, 1, 'every reader takes the newest per pull request');
  const doc = JSON.parse(second.out) as LabelDoc;
  assert.ok(
    doc.help.some((line) => line.includes('already held 1 line')),
    'a second line is ordinary and is said out loud rather than looking like a duplicate',
  );
});

test('a change eyes-on never assessed gets no register line, and the refusal names the command that fixes it', async (t) => {
  const { repo, merge, parent } = mergedRepo('label-noassess');
  const env = sandboxEnv('label-noassess');
  await initRepo(t, repo, env);

  const gh = mergedGh('label-noassess', { mergeSHA: merge });
  const path = { cwd: repo.path, env: { ...env, PATH: gh.path } };

  const refused = await captureCli(['label', '--pr', '7', '--format', 'json'], path);
  assert.equal(refused.code, EXIT_ERROR, 'a register row inventing a channel is worse than no row');
  const failure = JSON.parse(refused.out) as { error: string; help: string[] };
  assert.match(failure.error, /no recorded assessment for #7/);
  assert.ok(
    failure.help.some((line) => line.includes(`--base ${parent.slice(0, 12)}`) && line.includes(`--head ${merge.slice(0, 12)}`)),
    `the remedy has to be a command that works: ${JSON.stringify(failure.help)}`,
  );
  assert.equal(existsSync(join(env.EYES_HOME as string, 'ledger.jsonl')), false);

  // A dry run over the same state reports the link it did reconstruct and says
  // a real run would refuse. That distinction is what makes a sweep over
  // unassessed history a measurement of the link rather than of the database.
  const dry = await captureCli(['label', '--pr', '7', '--dry-run', '--format', 'json'], path);
  assert.equal(dry.code, EXIT_OK);
  const doc = JSON.parse(dry.out) as LabelDoc;
  assert.equal(doc.link, 'agrees');
  assert.equal(doc.merge_sha, merge);
  assert.equal(doc.would_record, false);
  assert.match(doc.would_record_blocked ?? '', /no recorded assessment/);
});

test('--dry-run reconstructs the whole chain and appends nothing', async (t) => {
  const { repo, merge, parent } = mergedRepo('label-dry');
  const env = sandboxEnv('label-dry');
  await initRepo(t, repo, env);
  await captureCli(['check', '--base', parent, '--head', merge, '--format', 'json'], { cwd: repo.path, env });

  const gh = mergedGh('label-dry', { mergeSHA: merge });
  const result = await captureCli(['label', '--pr', '7', '--dry-run', '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, PATH: gh.path },
  });
  const doc = JSON.parse(result.out) as LabelDoc;

  assert.equal(doc.dry_run, true);
  assert.equal(doc.recorded, false);
  assert.equal(doc.merge_sha, merge);
  assert.equal(existsSync(join(env.EYES_HOME as string, 'ledger.jsonl')), false);
  assert.ok(doc.help.some((line) => line.includes('--dry-run reconstructs the chain and appends no line')));
});

test('a merge commit the two sources disagree about is recorded as a disagreement, with no merge commit', async (t) => {
  const { repo, merge, parent } = mergedRepo('label-split');
  const env = sandboxEnv('label-split');
  await initRepo(t, repo, env);
  const check = await captureCli(['check', '--base', parent, '--head', merge, '--format', 'json'], { cwd: repo.path, env });
  // Named explicitly, because with the two sources contradicting each other
  // there is no merge commit for eyes-on to find an assessment by - which is
  // itself the point being asserted.
  const checkId = (JSON.parse(check.out) as { check_id: string }).check_id;

  const gh = mergedGh('label-split', { mergeSHA: 'f'.repeat(40) });
  const result = await captureCli(['label', '--pr', '7', '--check-id', checkId, '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, PATH: gh.path },
  });
  const doc = JSON.parse(result.out) as LabelDoc;

  assert.equal(doc.link, 'disagrees');
  assert.equal(doc.git_merge_sha, merge);
  assert.equal(doc.github_merge_sha, 'f'.repeat(40));
  assert.equal(doc.merge_sha, null, 'neither commit is recorded as the merge commit');
  assert.ok(doc.help.some((line) => line.includes('has nothing to blame against for this change')));
});

test('without gh the chain is still rebuilt from git, and the record says only one source answered', async (t) => {
  const { repo, merge, parent } = mergedRepo('label-nogh');
  const env = sandboxEnv('label-nogh');
  await initRepo(t, repo, env);
  await captureCli(['check', '--base', parent, '--head', merge, '--format', 'json'], { cwd: repo.path, env });

  const result = await captureCli(['label', '--pr', '7', '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, PATH: pathWithGitOnly('label-nogh-path') },
  });
  const doc = JSON.parse(result.out) as LabelDoc;

  assert.equal(result.code, EXIT_OK);
  assert.equal(doc.link, 'git-only');
  assert.equal(doc.merge_sha, merge, 'the (#7) subject alone names the commit that landed the change');
  assert.equal(doc.github_read, false);
  assert.equal(doc.github_unread_reason, 'gh-missing');
  // The merge time falls back to the committer date of the commit on the
  // default branch - when the change landed - and never to its author date,
  // which for a squash merge is when the branch's first commit was written.
  assert.equal(doc.merged_at, Number(repo.git(['show', '-s', '--format=%ct', merge]).trim()));
  assert.notEqual(doc.merged_at, null);
  assert.ok(doc.help.some((line) => line.includes('Install the GitHub CLI')));
});

test('a --check-id from another repository is not this repository\'s assessment', async (t) => {
  const first = mergedRepo('label-foreign-a');
  const second = mergedRepo('label-foreign-b');
  const env = sandboxEnv('label-foreign');
  await initRepo(t, first.repo, env);
  await initRepo(t, second.repo, env);

  // A real assessment, of the other repository's change, in the same state root.
  const other = await captureCli(
    ['check', '--base', second.parent, '--head', second.merge, '--format', 'json'],
    { cwd: second.repo.path, env },
  );
  const otherId = (JSON.parse(other.out) as { check_id: string }).check_id;
  await captureCli(['check', '--base', first.parent, '--head', first.merge, '--format', 'json'], {
    cwd: first.repo.path,
    env,
  });

  const gh = mergedGh('label-foreign', { mergeSHA: first.merge });
  const result = await captureCli(['label', '--pr', '7', '--check-id', otherId, '--format', 'json'], {
    cwd: first.repo.path,
    env: { ...env, PATH: gh.path },
  });

  // Refused rather than recorded: a check id is a digest of (repository, base,
  // head), so the row exists and describes somebody else's change. Writing it
  // would put that score into this repository's register under this
  // repository's id, where no later reader could tell.
  assert.equal(result.code, EXIT_ERROR);
  const failure = JSON.parse(result.out) as { error: string; help: string[] };
  assert.match(failure.error, /no recorded assessment for #7/);
  assert.ok(failure.help.some((line) => line.includes('is not this one')));
  assert.equal(existsSync(join(env.EYES_HOME as string, 'ledger.jsonl')), false);
});

test('label refuses to mutate from inside a no-mistakes run, and says which command it refused', async (t) => {
  const { repo, merge, parent } = mergedRepo('label-gate');
  const env = sandboxEnv('label-gate');
  await initRepo(t, repo, env);
  await captureCli(['check', '--base', parent, '--head', merge, '--format', 'json'], { cwd: repo.path, env });

  const result = await captureCli(['label', '--pr', '7', '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, NO_MISTAKES_GATE: '1' },
  });
  assert.equal(result.code, EXIT_USAGE);
  const failure = JSON.parse(result.out) as { error: string; help: string[] };
  assert.match(failure.error, /refusing to run "label" from inside a no-mistakes run/);
  assert.ok(failure.help.some((line) => line.includes('mutates eyes-on state')));
});

test('a mistyped pull request number is a usage error where the flag is read', async (t) => {
  const { repo } = mergedRepo('label-flag');
  const env = sandboxEnv('label-flag');
  await initRepo(t, repo, env);

  for (const value of ['abc', '42abc', '1e9', '0', '-1']) {
    const result = await captureCli(['label', '--pr', value, '--format', 'json'], { cwd: repo.path, env });
    assert.equal(result.code, EXIT_USAGE, `--pr ${value} should be a usage error`);
  }
  const missing = await captureCli(['label', '--format', 'json'], { cwd: repo.path, env });
  assert.equal(missing.code, EXIT_USAGE);
  assert.match(missing.out, /label needs --pr <n>/);
});

/* ------------------------------------------------------------------ *
 * The gh surface the register added.
 * ------------------------------------------------------------------ */

/**
 * The register reads a pull request through one more GET, and adding it must
 * not have widened what eyes-on can do to a pull request. The seven vectors are
 * asserted whole here; `test/coexistence.test.ts` asserts the prohibition.
 */
test('reading a pull request for the register is a read, and adds no seventh way to write one', () => {
  const emitted = ([
    { op: 'repo-slug' },
    { op: 'auth-status' },
    { op: 'pull-head', slug: SLUG, number: 7 },
    { op: 'pull-record', slug: SLUG, number: 7 },
    { op: 'list-comments', slug: SLUG, number: 7 },
    { op: 'create-comment', slug: SLUG, number: 7 },
    { op: 'update-comment', slug: SLUG, id: 9 },
  ] as GhOperation[]).map((operation) => argvFor(operation));

  for (const argv of emitted) {
    assert.equal(refusalFor(argv), null, `gh ${argv.join(' ')} is an invocation the product makes`);
  }
  const writes = emitted.filter((argv) => argv.includes('--method'));
  assert.equal(writes.length, 2, 'exactly two of the seven write, and both are issue comments');

  // The new vector reads a pull request and carries no way to become a write:
  // the same path with a method, with an input, or with both is not one of the
  // seven.
  const path = `repos/${SLUG}/pulls/7`;
  assert.deepEqual(argvFor({ op: 'pull-record', slug: SLUG, number: 7 }), ['api', path]);
  for (const argv of [
    ['api', '--method', 'PATCH', path],
    ['api', path, '--input', '-'],
    ['api', '--method', 'PUT', `${path}/merge`],
    ['api', path, '--jq', '.body'],
  ]) {
    assert.match(refusalFor(argv) ?? '', /never edits a pull request body/, `gh ${argv.join(' ')} was not refused`);
  }
});
