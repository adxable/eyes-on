import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter } from 'node:path';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureCli, pathWithGitOnly, sandboxEnv, stubAgent, stubGh, tempDir, tempRepo, type StubAgent, type TempRepo } from './helpers.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../src/cli/output.js';
import { findMarked, marker, MARKER_PREFIX, renderComment, type PullRequestView } from '../src/gh/comment.js';
import { parseComments, refusalFor } from '../src/gh/gh.js';

/**
 * The sticky pull-request comment.
 *
 * The acceptance condition is two sentences and both are asserted here against
 * a fake `gh` that records every invocation and keeps a pull-request body:
 *
 *   - **the body is byte-for-byte identical after the comment is published**;
 *   - **there is exactly one eyes-on comment however many times the change is
 *     recomputed and republished.**
 *
 * The first is asserted twice over, because a test that only compares the body
 * proves the command did not happen to touch it on this run. `refusalFor` is
 * the reason it cannot: it is the function every invocation passes through, and
 * the endpoint that edits a pull request body differs from the one eyes-on is
 * allowed to call by a single path segment.
 */


/** A pull request eyes-on did look at, pointing at the commit under assessment.
 *  The renderer derives staleness from this, so a test cannot hand it one. */
function observed(head: string, overrides: Partial<Extract<PullRequestView, { checked: true }>> = {}): PullRequestView {
  return { checked: true, slug: SLUG, head, comments: 0, marked: 0, existingId: null, existingUrl: null, ...overrides };
}

const BODY = '## Summary\n\nno-mistakes wrote this body and regenerates it on every push.\n\n<!-- no-mistakes:attestation -->\n';
const SLUG = 'acme/widgets';
const PR = 42;

test('the allow-list refuses everything that could touch a pull request', () => {
  // Permitted: the two comment endpoints and the two reads.
  assert.equal(refusalFor(['repo', 'view', '--json', 'nameWithOwner']), null);
  assert.equal(refusalFor(['api', `repos/${SLUG}/issues/${PR}/comments`]), null);
  assert.equal(refusalFor(['api', '--paginate', `repos/${SLUG}/issues/${PR}/comments`]), null);
  assert.equal(refusalFor(['api', `repos/${SLUG}/pulls/${PR}`, '--jq', '.head.sha']), null);
  assert.equal(refusalFor(['api', '--method', 'POST', `repos/${SLUG}/issues/${PR}/comments`, '--input', '-']), null);
  assert.equal(refusalFor(['api', '--method', 'PATCH', `repos/${SLUG}/issues/comments/9`, '--input', '-']), null);

  // The pull request body, which is one path segment away from the permitted
  // comment update and belongs to no-mistakes.
  assert.match(refusalFor(['api', '--method', 'PATCH', `repos/${SLUG}/issues/${PR}`]) ?? '', /never edits a pull request body/);
  assert.match(refusalFor(['api', '--method', 'PATCH', `repos/${SLUG}/pulls/${PR}`]) ?? '', /never edits a pull request body/);
  assert.match(refusalFor(['api', '-X', 'PATCH', `repos/${SLUG}/pulls/${PR}`]) ?? '', /never edits a pull request body/);
  assert.match(refusalFor(['api', '--method=PATCH', `repos/${SLUG}/pulls/${PR}`]) ?? '', /never edits a pull request body/);

  // Merging, reviewing and every other porcelain verb.
  for (const argv of [
    ['pr', 'edit', '42', '--body', 'x'],
    ['pr', 'merge', '42'],
    ['pr', 'review', '42', '--approve'],
    ['pr', 'close', '42'],
    ['pr', 'comment', '42', '--body', 'x'],
    ['issue', 'edit', '42'],
    ['release', 'create', 'v1'],
  ]) {
    assert.ok(refusalFor(argv) !== null, `gh ${argv.join(' ')} must be refused`);
  }

  // Writes to endpoints that are not comments, whatever the method.
  assert.ok(refusalFor(['api', '--method', 'PUT', `repos/${SLUG}/pulls/${PR}/merge`]) !== null);
  assert.ok(refusalFor(['api', '--method', 'POST', `repos/${SLUG}/pulls/${PR}/reviews`]) !== null);
  assert.ok(refusalFor(['api', '--method', 'DELETE', `repos/${SLUG}/issues/comments/9`]) !== null);
  assert.ok(refusalFor(['api', '--method', 'POST', `repos/${SLUG}/issues/${PR}/comments/extra`]) !== null);
  // A read of something eyes-on has no business reading.
  assert.ok(refusalFor(['api', 'user/repos']) !== null);
});

test('the marker is one line, carries the machine contract, and finds its own comment', () => {
  const line = marker({
    head_sha: 'a'.repeat(40),
    score: 58,
    score_max: 120,
    band: 'wskazane',
    unverified: false,
    decision: 'read',
    check_id: 'abc123',
  });
  assert.ok(line.startsWith(MARKER_PREFIX));
  assert.ok(!line.includes('\n'), 'a marker split across lines would not be found again');
  const payload = JSON.parse(line.slice(MARKER_PREFIX.length, line.lastIndexOf(' -->'))) as { band: string };
  // The band identifier stays the report's Polish machine value; only the label
  // beside it is English.
  assert.equal(payload.band, 'wskazane');

  const comments = [{ body: 'someone else' }, { body: `${line}\n**eyes-on**` }, { body: 'and another' }];
  assert.equal(findMarked(comments)?.body.includes('eyes-on'), true);
  assert.equal(findMarked([{ body: 'nothing here' }]), null);

  // GitHub's "Quote reply" copies the body verbatim behind a `> `, marker and
  // all. That comment belongs to whoever quoted it, so it is not the one to
  // update - even when the eyes-on comment it quoted is gone.
  const quoted = { body: `${line.split('\n').map((entry) => `> ${entry}`).join('\n')}\n\nis this right?` };
  assert.equal(findMarked([quoted]), null);
  assert.equal(findMarked([quoted, { body: `${line}\nthe real one` }])?.body.includes('the real one'), true);
});

test('a paginated comment listing is several arrays, and all of them are read', () => {
  // `gh api --paginate` concatenates one array per page rather than merging
  // them, so a busy pull request arrives as `[...][...]` - not a JSON document.
  const page = (id: number, body: string): string => JSON.stringify([{ id, body, html_url: null, user: { login: 'x' } }]);
  const comments = parseComments(`${page(1, 'first')}${page(2, `${MARKER_PREFIX}{} -->`)}`);
  assert.equal(comments.length, 2);
  assert.ok(findMarked(comments));
});

test('the comment says what to read and never becomes a second pull-request body', () => {
  const body = renderComment({
    check: {
      id: 'abc123',
      repo_id: 'r',
      branch: 'work',
      base_sha: 'b'.repeat(40),
      head_sha: 'h'.repeat(40),
      score: 58,
      score_max: 120,
      band: 'wskazane',
      drift: 2,
      intent: 'why',
      intent_source: 'flag',
      drift_intent: 'why',
      status: 'done',
      trusted_config_sha: null,
      created_at: 0,
      updated_at: 0,
    },
    spots: [
      { check_id: 'abc123', file: 'deploy/my values.yaml', line: 4, category: 'correctness', why: 'check the replica count', weight: 10, source: 'model' },
    ],
    hits: [{ glob: 'deploy/**', why: 'costs a machine', files: ['deploy/my values.yaml'] }],
    decision: { check_id: 'abc123', action: 'read', reason: null, decided_by: 'crewmate', decided_at: 0, hits_fingerprint: 'f', config_sha: null },
    driftItems: [{ check_id: 'abc123', kind: 'unrequested_in_diff', position: 0, item: 'a health endpoint nobody asked for' }],
    signals: [{ name: 'fix_history', normalized: 0.72 }, { name: 'churn', normalized: 0 }],
    pullRequest: observed('h'.repeat(40)),
  });

  assert.ok(body.startsWith(MARKER_PREFIX));
  assert.match(body, /\*\*eyes-on - 58 of at most 120, channel: read the indicated fragments\*\*/);
  assert.match(body, /1\. `deploy\/my values\.yaml:4` - correctness - check the replica count/);
  assert.match(body, /Why 58: fix_history 0\.72$/m, 'only the signals that moved the score are named');
  assert.match(body, /Hard rule: `deploy\/\*\*` -> full review - costs a machine \(decision: read\)/);
  // One path per line, because git does not quote a space and this is exactly
  // the kind of path a hard rule protects.
  assert.match(body, /^ {2}- `deploy\/my values\.yaml`$/m);
  assert.match(body, /Intent versus diff: 2\/5 - a health endpoint nobody asked for/);
  assert.match(body, /reddens this pull request or holds up a merge/);
  assert.match(body, /does not edit this pull request's body or file a review/);
});

test('a check with no recorded maximum is published without a denominator, not with an invented one', () => {
  // Rows written before eyes-on stored `score_max` carry a score computed under
  // weights that summed to 1.00. Labelling that number with today's maximum
  // would put a denominator on the comment the change was never scored against,
  // which is the one thing `status` already refuses to do.
  const row = {
    id: 'abc123',
    repo_id: 'r',
    branch: 'work',
    base_sha: 'b'.repeat(40),
    head_sha: 'h'.repeat(40),
    score: 58,
    score_max: null,
    band: 'wskazane',
    drift: null,
    intent: null,
    intent_source: null,
    drift_intent: null,
    status: 'done',
    trusted_config_sha: null,
    created_at: 0,
    updated_at: 0,
  };
  const body = renderComment({
    check: row,
    spots: [],
    hits: [],
    decision: undefined,
    driftItems: [],
    signals: [],
    pullRequest: observed(row.head_sha),
  });

  assert.match(body, /\*\*eyes-on - 58, channel: read the indicated fragments\*\*/);
  assert.doesNotMatch(body, /of at most/);
  assert.match(body, /before eyes-on stored the maximum a score can reach/);

  // And the machine contract says the same: null, not a number nobody recorded.
  const line = body.split('\n')[0] ?? '';
  const payload = JSON.parse(line.slice(MARKER_PREFIX.length, line.lastIndexOf(' -->'))) as { score_max: number | null };
  assert.equal(payload.score_max, null);
});

test('an unverified check is published as one, because no hard rule behind that channel was evaluated', () => {
  // `unverified` means the trusted configuration could not be read, so `assess`
  // ran with no hard rules at all and the band is a floor. The comment is the
  // copy a reviewer reads and argues with, so it is the one surface that must
  // not present that band as measured.
  const row = {
    id: 'abc123',
    repo_id: 'r',
    branch: 'work',
    base_sha: 'b'.repeat(40),
    head_sha: 'h'.repeat(40),
    score: 42,
    score_max: 120,
    band: 'wskazane',
    drift: null,
    intent: null,
    intent_source: null,
    drift_intent: null,
    status: 'unverified',
    trusted_config_sha: null,
    created_at: 0,
    updated_at: 0,
  };
  const input = {
    check: row,
    spots: [],
    hits: [],
    decision: undefined,
    driftItems: [],
    signals: [],
    pullRequest: observed(row.head_sha),
  };
  const body = renderComment(input);

  assert.match(body, /\*\*eyes-on - 42 of at most 120, channel: read the indicated fragments\*\*/);
  assert.match(body, /no hard rule was evaluated and this band is a lower bound/);

  // And the machine contract carries it too, so a reader of the marker is not
  // told less than a reader of the comment.
  const line = body.split('\n')[0] ?? '';
  const payload = JSON.parse(line.slice(MARKER_PREFIX.length, line.lastIndexOf(' -->'))) as { unverified: boolean };
  assert.equal(payload.unverified, true);

  const verified = renderComment({ ...input, check: { ...row, status: 'done' } });
  assert.doesNotMatch(verified, /lower bound/, 'a check whose rules were evaluated carries no caveat');
  const verifiedLine = verified.split('\n')[0] ?? '';
  const verifiedPayload = JSON.parse(
    verifiedLine.slice(MARKER_PREFIX.length, verifiedLine.lastIndexOf(' -->')),
  ) as { unverified: boolean };
  assert.equal(verifiedPayload.unverified, false);
});

// --- end to end, through the CLI -------------------------------------------

function repoWith(agent: StubAgent): TempRepo {
  const repo = tempRepo('comment');
  repo.commitFiles('chore: configure eyes-on', {
    '.eyes-on.yml': [
      'schema: eyes-on/v1',
      'hard_rules:',
      '  - glob: "deploy/**"',
      '    why: "deployment configuration - a mistake costs a machine, not a test"',
      'model:',
      `  agent: ${agent.agent}`,
      '',
    ].join('\n'),
    'src/a.ts': 'export const a = 1;\n',
  });
  repo.git(['checkout', '-q', '-b', 'work']);
  repo.commitFiles('chore: bump replicas', {
    'deploy/values.yaml': 'replicas: 4\n',
    'src/a.ts': 'export const a = 2;\nexport const b = 3;\n',
  });
  return repo;
}

async function initRepo(t: TestContext, repo: TempRepo, env: Record<string, string>): Promise<void> {
  await captureCli(['init'], { cwd: repo.path, env });
  t.after(async () => {
    await captureCli(['daemon', 'stop'], { cwd: repo.path, env });
  });
}

interface CommentDoc {
  action: string;
  dry_run: boolean;
  comment_id: number | null;
  eyes_on_comments_found: number;
  comments_on_pr: number;
  fragments: number;
  gate: string;
  decision: string | null;
  stale: boolean;
  body: string;
  exit_code: number;
  help: string[];
}

const SPOTLIGHT_ANSWER = JSON.stringify({
  spotlight: [
    { file: 'deploy/values.yaml', line: 1, category: 'correctness', why: 'confirm the replica count is deliberate' },
    { file: 'src/a.ts', line: 1, category: 'maintainability', why: 'the second export duplicates the first' },
  ],
});

test('acceptance: publishing leaves the pull-request body byte for byte, and leaves exactly one comment', async (t) => {
  const agent = stubAgent('comment-sticky', [SPOTLIGHT_ANSWER]);
  const repo = repoWith(agent);
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  const gh = stubGh('comment-sticky', { slug: SLUG, number: PR, headSHA: head, body: BODY });
  const env: Record<string, string> = { ...sandboxEnv('comment-sticky'), PATH: `${agent.dir}${delimiter}${gh.path}` };
  await initRepo(t, repo, env);

  await captureCli(['check', '--format', 'json'], { cwd: repo.path, env });
  await captureCli(['spotlight', '--format', 'json'], { cwd: repo.path, env });

  const first = JSON.parse(
    (await captureCli(['comment', '--pr', String(PR), '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CommentDoc;
  assert.equal(first.action, 'created');
  assert.equal(gh.comments().length, 1);
  // The run that creates the comment names it. An agent that publishes and then
  // wants to address what it just wrote has the id on the first run, not only
  // on the second.
  assert.equal(first.comment_id, gh.comments()[0]?.id);

  // Recompute and republish twice more: the same comment is edited in place.
  for (const round of [1, 2]) {
    await captureCli(['check', '--format', 'json'], { cwd: repo.path, env });
    const again = JSON.parse(
      (await captureCli(['comment', '--pr', String(PR), '--format', 'json'], { cwd: repo.path, env })).out,
    ) as CommentDoc;
    assert.equal(again.action, 'updated', `round ${round} updates rather than adds`);
    assert.equal(again.eyes_on_comments_found, 1);
    assert.equal(again.comment_id, first.comment_id, `round ${round} names the same comment`);
  }

  const comments = gh.comments();
  assert.equal(comments.length, 1, 'exactly one comment however many recomputations');
  assert.equal(comments.filter((comment) => comment.body.includes(MARKER_PREFIX)).length, 1);
  assert.match(comments[0]?.body ?? '', /confirm the replica count is deliberate/);

  // The body, byte for byte.
  assert.equal(gh.body(), BODY);

  // And the stronger statement: no invocation could have touched it. Every
  // write was a comment endpoint, and nothing reached `gh pr` at all.
  const writes = gh.calls().filter((argv) => argv.includes('--method'));
  assert.ok(writes.length > 0);
  for (const argv of writes) {
    const method = argv[argv.indexOf('--method') + 1];
    const endpoint = argv.find((arg, index) => index > 0 && !arg.startsWith('-') && argv[index - 1] !== '--method');
    assert.ok(
      (method === 'POST' && endpoint === `repos/${SLUG}/issues/${PR}/comments`) ||
        (method === 'PATCH' && /^repos\/.+\/issues\/comments\/\d+$/.test(endpoint ?? '')),
      `write went to ${method ?? ''} ${endpoint ?? ''}`,
    );
  }
  assert.equal(gh.calls().filter((argv) => argv[0] === 'pr').length, 0, 'gh pr is never reached');
});

test('a comment already on the pull request from somebody else is left alone', async (t) => {
  const agent = stubAgent('comment-others', [SPOTLIGHT_ANSWER]);
  const repo = repoWith(agent);
  const head = repo.git(['rev-parse', 'HEAD']).trim();

  // Two comments nobody here wrote. The second is what GitHub's "Quote reply"
  // produces from an eyes-on comment: the marker verbatim, behind a `> `. It is
  // the dangerous one, because it carries the string the sticky comment is
  // found by while belonging to the reviewer who quoted it.
  const plain = { id: 501, body: 'Looks fine to me, but check the replica count.' };
  const quoting = {
    id: 502,
    body: [`> ${marker({
      head_sha: head,
      score: 58,
      score_max: 120,
      band: 'wskazane',
      unverified: false,
      decision: null,
      check_id: 'somebody-elses-run',
    })}`, '> **eyes-on - 58 of at most 120**', '', 'Why does it say that?'].join('\n'),
  };

  const gh = stubGh('comment-others', {
    slug: SLUG,
    number: PR,
    headSHA: head,
    body: BODY,
    comments: [plain, quoting],
  });
  const env: Record<string, string> = { ...sandboxEnv('comment-others'), PATH: `${agent.dir}${delimiter}${gh.path}` };
  await initRepo(t, repo, env);

  await captureCli(['check'], { cwd: repo.path, env });
  await captureCli(['spotlight', '--no-model'], { cwd: repo.path, env });
  const created = JSON.parse(
    (await captureCli(['comment', '--pr', String(PR), '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CommentDoc;
  const updated = JSON.parse(
    (await captureCli(['comment', '--pr', String(PR), '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CommentDoc;

  // The quoted marker was not mistaken for eyes-on's own comment: the first run
  // added one, and the second edited that one rather than the reviewer's.
  assert.equal(created.action, 'created');
  assert.equal(updated.action, 'updated');
  assert.equal(updated.eyes_on_comments_found, 1);

  const comments = gh.comments();
  assert.equal(comments.length, 3, 'the two that were there, plus exactly one from eyes-on');
  for (const before of [plain, quoting]) {
    const after = comments.find((comment) => comment.id === before.id);
    assert.ok(after, `comment ${before.id} is still there`);
    assert.equal(after.body, before.body, `comment ${before.id} was not rewritten`);
    assert.equal(after.user?.login, 'somebody-else', 'and still belongs to whoever wrote it');
  }

  const ours = comments.filter((comment) => comment.body.startsWith(MARKER_PREFIX));
  assert.equal(ours.length, 1);
  assert.ok(ours[0] && ours[0].id !== plain.id && ours[0].id !== quoting.id);

  // Every write went to the comment eyes-on created, and none to either of the
  // two it found.
  const patched = gh
    .calls()
    .filter((argv) => argv[argv.indexOf('--method') + 1] === 'PATCH')
    .map((argv) => argv.find((arg) => /^repos\/.+\/issues\/comments\/\d+$/.test(arg)) ?? '');
  assert.ok(patched.length > 0);
  for (const endpoint of patched) {
    assert.equal(endpoint, `repos/${SLUG}/issues/comments/${ours[0]?.id ?? 0}`);
  }

  assert.equal(gh.body(), BODY);
});

test('a second eyes-on comment is counted, not hidden behind the one that gets updated', async (t) => {
  // `eyes_on_comments_found` exists to make a duplicate visible, so it has to
  // be able to say two. Derived from the single comment about to be updated it
  // could only ever say one, and the defect it was added for would be invisible
  // in the field that reports it.
  const agent = stubAgent('comment-duplicate', [SPOTLIGHT_ANSWER]);
  const repo = repoWith(agent);
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  const twin = (id: number, tail: string): { id: number; body: string } => ({
    id,
    body: `${marker({
      head_sha: head,
      score: 58,
      score_max: 120,
      band: 'wskazane',
      unverified: false,
      decision: null,
      check_id: `run-${id}`,
    })}\n${tail}`,
  });
  const gh = stubGh('comment-duplicate', {
    slug: SLUG,
    number: PR,
    headSHA: head,
    body: BODY,
    comments: [twin(601, 'the older one'), twin(602, 'the duplicate')],
  });
  const env: Record<string, string> = { ...sandboxEnv('comment-duplicate'), PATH: `${agent.dir}${delimiter}${gh.path}` };
  await initRepo(t, repo, env);

  await captureCli(['check'], { cwd: repo.path, env });
  await captureCli(['spotlight', '--no-model'], { cwd: repo.path, env });
  const doc = JSON.parse(
    (await captureCli(['comment', '--pr', String(PR), '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CommentDoc;

  assert.equal(doc.eyes_on_comments_found, 2, 'both are counted');
  assert.equal(doc.comment_id, 601, 'the oldest is the one updated');
  assert.equal(gh.comments().length, 2, 'and no third is added');
  assert.equal(
    gh.comments().find((comment) => comment.id === 602)?.body.endsWith('the duplicate'),
    true,
    'eyes-on never deletes or rewrites the other one',
  );
  assert.ok(
    doc.help.some((line) => line.includes('2 eyes-on comments')),
    'and the caller is told, because eyes-on cannot clean it up itself',
  );
});

test('--dry-run prints the comment and calls no writing endpoint', async (t) => {
  const agent = stubAgent('comment-dry', [SPOTLIGHT_ANSWER]);
  const repo = repoWith(agent);
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  const gh = stubGh('comment-dry', { slug: SLUG, number: PR, headSHA: head, body: BODY });
  const env: Record<string, string> = { ...sandboxEnv('comment-dry'), PATH: `${agent.dir}${delimiter}${gh.path}` };
  await initRepo(t, repo, env);

  await captureCli(['check'], { cwd: repo.path, env });
  await captureCli(['spotlight', '--no-model'], { cwd: repo.path, env });

  const result = await captureCli(['comment', '--pr', String(PR), '--dry-run', '--format', 'json'], {
    cwd: repo.path,
    env,
  });
  const doc = JSON.parse(result.out) as CommentDoc;

  assert.equal(result.code, EXIT_OK);
  assert.equal(doc.dry_run, true);
  assert.equal(doc.action, 'would create');
  assert.ok(doc.body.startsWith(MARKER_PREFIX));
  assert.equal(gh.comments().length, 0, 'nothing was published');
  assert.equal(gh.calls().filter((argv) => argv.includes('--method')).length, 0, 'no writing endpoint was called');
  assert.equal(gh.body(), BODY);
});

test('the comment carries the gate and the decision, and says which is which', async (t) => {
  const agent = stubAgent('comment-gate', [SPOTLIGHT_ANSWER]);
  const repo = repoWith(agent);
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  const gh = stubGh('comment-gate', { slug: SLUG, number: PR, headSHA: head, body: BODY });
  const env: Record<string, string> = { ...sandboxEnv('comment-gate'), PATH: `${agent.dir}${delimiter}${gh.path}` };
  await initRepo(t, repo, env);

  await captureCli(['check'], { cwd: repo.path, env });
  await captureCli(['spotlight', '--no-model'], { cwd: repo.path, env });

  const parked = JSON.parse(
    (await captureCli(['comment', '--pr', String(PR), '--dry-run', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CommentDoc;
  assert.equal(parked.gate, 'must_read');
  assert.match(parked.body, /decision: not recorded yet/);
  assert.ok(parked.help.some((line) => line.includes('gate is still parked')));

  await captureCli(['axi', 'respond', '--action', 'waive', '--reason', 'agreed in the deploy review'], {
    cwd: repo.path,
    env: { ...env, EYES_ON_ACTOR: 'crewmate' },
  });

  const answered = JSON.parse(
    (await captureCli(['comment', '--pr', String(PR), '--dry-run', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CommentDoc;
  assert.equal(answered.gate, 'none');
  assert.equal(answered.decision, 'waive');
  assert.match(answered.body, /decision: waive - agreed in the deploy review/);
});

test('a pull request that has moved on is described as such rather than silently', async (t) => {
  const agent = stubAgent('comment-stale', [SPOTLIGHT_ANSWER]);
  const repo = repoWith(agent);
  const gh = stubGh('comment-stale', { slug: SLUG, number: PR, headSHA: 'f'.repeat(40), body: BODY });
  const env: Record<string, string> = { ...sandboxEnv('comment-stale'), PATH: `${agent.dir}${delimiter}${gh.path}` };
  await initRepo(t, repo, env);

  await captureCli(['check'], { cwd: repo.path, env });
  await captureCli(['spotlight', '--no-model'], { cwd: repo.path, env });
  const doc = JSON.parse(
    (await captureCli(['comment', '--pr', String(PR), '--format', 'json'], { cwd: repo.path, env })).out,
  ) as CommentDoc;

  assert.equal(doc.stale, true);
  assert.match(doc.body, /This assessment is of/);
  assert.ok(doc.help.some((line) => line.includes('pull request head is not the commit')));
  assert.equal(gh.body(), BODY);
});

test('publishing an assessment nobody made says so instead of inventing one', async (t) => {
  const agent = stubAgent('comment-nocheck', [SPOTLIGHT_ANSWER]);
  const repo = repoWith(agent);
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  const gh = stubGh('comment-nocheck', { slug: SLUG, number: PR, headSHA: head, body: BODY });
  const env: Record<string, string> = { ...sandboxEnv('comment-nocheck'), PATH: `${agent.dir}${delimiter}${gh.path}` };
  await initRepo(t, repo, env);

  const result = await captureCli(['comment', '--pr', String(PR), '--format', 'json'], { cwd: repo.path, env });
  assert.equal(result.code, EXIT_ERROR);
  assert.match(result.out, /no eyes-on assessment to publish/);
  assert.equal(gh.calls().length, 0, 'nothing was asked of GitHub at all');

  const missing = await captureCli(['comment', '--format', 'json'], { cwd: repo.path, env });
  assert.equal(missing.code, EXIT_USAGE);
  assert.match(missing.out, /comment needs --pr/);
});

/**
 * gh, in the three states it can actually be in.
 *
 * The suite used to put a fake gh on PATH for every one of these tests, so a
 * host without the GitHub CLI and a pull request GitHub refuses were both
 * uncovered - and both were reported as something they were not.
 */

function repoWithoutModel(prefix: string): TempRepo {
  const repo = tempRepo(prefix);
  repo.commitFiles('chore: configure eyes-on', {
    '.eyes-on.yml': 'schema: eyes-on/v1\n',
    'src/a.ts': 'export const a = 1;\n',
  });
  repo.git(['checkout', '-q', '-b', 'work']);
  repo.commitFiles('feat: change one thing', { 'src/a.ts': 'export const a = 2;\nexport const b = 3;\n' });
  return repo;
}

test('--dry-run really is a preview without gh, and says what it could not check', async (t) => {
  const repo = repoWithoutModel('comment-nogh');
  // git and nothing else: this is the host the publish path's own advice - "use
  // --dry-run" - has to be true on.
  const env: Record<string, string> = { ...sandboxEnv('comment-nogh'), PATH: pathWithGitOnly('comment-nogh-path') };
  await initRepo(t, repo, env);
  await captureCli(['check', '--no-model', '--format', 'json'], { cwd: repo.path, env });

  const preview = await captureCli(['comment', '--pr', String(PR), '--dry-run', '--format', 'json'], {
    cwd: repo.path,
    env,
  });
  const doc = JSON.parse(preview.out) as CommentDoc & {
    pull_request_checked: boolean;
    unchecked_reason: string | null;
    comments_on_pr: number | null;
    eyes_on_comments_found: number | null;
    repo: string | null;
    stale: boolean | null;
    pr_head: string | null;
  };

  assert.equal(preview.code, EXIT_OK, `--dry-run must work without gh: ${preview.err}`);
  // The comment itself is assembled from what was recorded, which needs nothing
  // from GitHub.
  assert.ok(doc.body.startsWith(MARKER_PREFIX));
  assert.match(doc.body, /eyes-on - /);

  // And the price is stated rather than guessed at.
  assert.equal(doc.pull_request_checked, false);
  assert.equal(doc.unchecked_reason, 'gh-missing');
  assert.notEqual(doc.action, 'would create', 'nothing looked at the pull request, so neither verb is known');
  assert.equal(doc.action, 'would create or update');
  assert.equal(doc.comments_on_pr, null, 'a count nobody read is not zero');
  assert.equal(doc.eyes_on_comments_found, null);
  assert.equal(doc.repo, null);
  // The one that is not a count: `false` here would assert that the assessment
  // describes the head the pull request has now, which is the fact no gh call
  // was made to establish.
  assert.equal(doc.stale, null, 'staleness nobody read is not "not stale"');
  assert.equal(doc.pr_head, null);
  assert.match(doc.body, /whether it still points at this commit is unchecked/);
  assert.ok(doc.help.some((line) => line.includes('never looked at the pull request')));
  assert.ok(doc.help.some((line) => line.includes('The GitHub CLI is not installed')));
  assert.match(preview.err, /never checked/);

  // The publish path still refuses, because there the refusal is true.
  const publish = await captureCli(['comment', '--pr', String(PR), '--format', 'json'], { cwd: repo.path, env });
  assert.equal(publish.code, EXIT_ERROR);
  assert.match(publish.out, /gh is not on PATH/);
});

test('a pull request GitHub refuses is reported as GitHub answering, not as an eyes-on bug', async (t) => {
  const agent = stubAgent('comment-404', [SPOTLIGHT_ANSWER]);
  const repo = repoWith(agent);
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  // The fake gh knows about PR 42 only, so every call about another number
  // exits non-zero - which is what a 404 or a pull request nobody may see looks
  // like from here.
  const gh = stubGh('comment-404', { slug: SLUG, number: PR, headSHA: head, body: BODY });
  const env: Record<string, string> = { ...sandboxEnv('comment-404'), PATH: `${agent.dir}${delimiter}${gh.path}` };
  await initRepo(t, repo, env);
  await captureCli(['check', '--format', 'json'], { cwd: repo.path, env });

  const result = await captureCli(['comment', '--pr', '12345', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as { error: string; help: string[] };

  assert.equal(result.code, EXIT_ERROR);
  assert.match(doc.error, /gh could not read the comments of acme\/widgets#12345/);
  assert.match(doc.error, /gh exited 1/, 'the status gh actually returned');
  assert.ok(
    doc.help.every((line) => !line.includes('eyes-on bug')),
    'a pull request number nobody can read is not a defect in eyes-on',
  );
  assert.ok(doc.help.some((line) => line.includes('gh auth status')), 'the remedy is one that works in this state');

  // --dry-run is named in this help, so what it says about it has to be true.
  // It reads the pull request before rendering, so it fails identically here -
  // and the help must not offer it as a way past this.
  const dry = await captureCli(['comment', '--pr', '12345', '--dry-run', '--format', 'json'], { cwd: repo.path, env });
  const dryDoc = JSON.parse(dry.out) as { error: string; help: string[] };
  assert.equal(dry.code, EXIT_ERROR, '--dry-run takes the same path, so it fails the same way');
  assert.equal(dryDoc.error, doc.error);
  assert.ok(
    doc.help.every((line) => !/--dry-run.*without calling GitHub/.test(line)),
    'a remedy that reproduces the failure is not a remedy',
  );
  assert.ok(doc.help.some((line) => line.includes('--dry-run') && line.includes('does not get past this')));
});

/**
 * A `gh` that is not the fake pull request: a program of a few lines, used to
 * reach the two states the real one cannot be asked for - a gh that cannot name
 * a repository, and a gh something kills.
 *
 * The shebang is this process's own node, so the PATH the test hands the CLI
 * can hold git and this program and nothing else.
 */
function fakeGh(prefix: string, script: string): string {
  const dir = tempDir(`${prefix}-gh`);
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
  return `${dir}${delimiter}${pathWithGitOnly(`${prefix}-git`)}`;
}

test('a gh that cannot name the repository is told apart from a gh that is not installed', async (t) => {
  const repo = repoWithoutModel('comment-noslug');
  // gh is installed and just ran; telling this reader to install it is the
  // remedy that cannot work in the state they are in.
  const env: Record<string, string> = {
    ...sandboxEnv('comment-noslug'),
    PATH: fakeGh('comment-noslug', "process.stderr.write('not logged in\\n'); process.exit(1);"),
  };
  await initRepo(t, repo, env);
  await captureCli(['check', '--no-model', '--format', 'json'], { cwd: repo.path, env });

  const preview = await captureCli(['comment', '--pr', String(PR), '--dry-run', '--format', 'json'], {
    cwd: repo.path,
    env,
  });
  const doc = JSON.parse(preview.out) as CommentDoc & {
    pull_request_checked: boolean;
    unchecked_reason: string | null;
    stale: boolean | null;
  };

  assert.equal(preview.code, EXIT_OK);
  assert.equal(doc.pull_request_checked, false);
  assert.equal(doc.unchecked_reason, 'no-repository', 'a different state from an absent gh');
  assert.equal(doc.stale, null);
  assert.ok(
    doc.help.every((line) => !line.includes('Install the GitHub CLI')),
    'gh is installed and ran, so installing it is not the remedy',
  );
  assert.ok(doc.help.some((line) => line.includes('gh auth status')));
});

test('a gh something kills is reported as a killed process, not as an eyes-on bug', async (t) => {
  const repo = repoWithoutModel('comment-killed');
  // No error and no status - the shape the out-of-memory killer and a Ctrl-C
  // both produce, and the one that used to arrive as an allow-list refusal.
  const env: Record<string, string> = {
    ...sandboxEnv('comment-killed'),
    PATH: fakeGh('comment-killed', "process.kill(process.pid, 'SIGKILL');"),
  };
  await initRepo(t, repo, env);
  await captureCli(['check', '--no-model', '--format', 'json'], { cwd: repo.path, env });

  const result = await captureCli(['comment', '--pr', String(PR), '--dry-run', '--format', 'json'], {
    cwd: repo.path,
    env,
  });
  const doc = JSON.parse(result.out) as { error: string; help: string[] };

  assert.equal(result.code, EXIT_ERROR);
  assert.match(doc.error, /gh ran and was killed by SIGKILL/);
  assert.ok(
    doc.help.every((line) => !line.includes('eyes-on bug')),
    'a subprocess something else killed is not a defect in eyes-on',
  );
  assert.ok(doc.help.some((line) => line.includes('run the command again')));
});
