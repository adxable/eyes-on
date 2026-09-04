import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { captureCli, sandboxEnv, tempRepo, type TempRepo } from './helpers.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../src/cli/output.js';
import { Database } from '../src/db/db.js';
import { hitsFingerprint } from '../src/db/gate.js';

/**
 * The `must_read` gate.
 *
 * The acceptance condition is three sentences and each is asserted here: a
 * hard-rule hit parks the run; `respond --action waive --reason` records the
 * decision and the reason; and **no answer blocks nothing except the eyes-on
 * run itself** - no exit code moves, and every other command keeps working
 * while the gate is open.
 */

const CONFIG = `schema: eyes-on/v1
hard_rules:
  - glob: "deploy/**"
    why: "deployment configuration - a mistake costs a machine, not a test"
`;

/** A branch that touches the protected path, so a rule fires. */
function parkedRepo(prefix: string): TempRepo {
  const repo = tempRepo(prefix);
  repo.commitFiles('chore: configure eyes-on', { '.eyes-on.yml': CONFIG, 'src/a.ts': 'export const a = 1;\n' });
  repo.git(['checkout', '-q', '-b', 'work']);
  repo.commitFiles('chore: bump replicas', { 'deploy/values.yaml': 'replicas: 4\n' });
  return repo;
}

async function initRepo(t: TestContext, repo: TempRepo, env: Record<string, string>): Promise<void> {
  await captureCli(['init'], { cwd: repo.path, env });
  t.after(async () => {
    await captureCli(['daemon', 'stop'], { cwd: repo.path, env });
  });
}

interface CheckDoc {
  check_id: string;
  band: string;
  gate: string;
  decision: string | null;
  decision_reason: string | null;
  decided_by: string | null;
  exit_code: number;
  help: string[];
}

interface RespondDoc {
  check_id: string;
  gate_was: string;
  gate: string;
  status: string;
  action: string;
  reason: string | null;
  decided_by: string;
  previous_action: string | null;
  decisions: { action: string; reason: string | null }[];
  exit_code: number;
}

function openDb(env: Record<string, string>): Database {
  return Database.open(join(env.EYES_HOME as string, 'state.sqlite'));
}

test('the hits a decision answers are a set: order and repetition do not name a different one', () => {
  // Both sides of the comparison derive from one assessment today, so this is
  // the property the fingerprint is documented to have rather than a sequence
  // anything currently produces - and a reader who adds a second source of hits
  // should find it already true.
  const one = { glob: 'deploy/**', file: 'deploy/my values.yaml' };
  const two = { glob: 'infra/**', file: 'infra/main.tf' };
  assert.equal(hitsFingerprint([one, two]), hitsFingerprint([two, one]));
  assert.equal(hitsFingerprint([one, two, one]), hitsFingerprint([one, two]));
  assert.notEqual(hitsFingerprint([one]), hitsFingerprint([one, two]));
  assert.notEqual(hitsFingerprint([]), hitsFingerprint([one]));
});

test('acceptance: a hard-rule hit parks the run, and parking changes no exit code', async (t) => {
  const repo = parkedRepo('gate-park');
  const env = sandboxEnv('gate-park');
  await initRepo(t, repo, env);

  const result = await captureCli(['check', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as CheckDoc;

  assert.equal(doc.band, 'pelna');
  assert.equal(doc.gate, 'must_read');
  assert.equal(doc.decision, null);
  assert.equal(result.code, EXIT_OK, 'a parked run still exits 0');
  assert.equal(doc.exit_code, EXIT_OK);
  assert.ok(
    doc.help.some((line) => line.includes('eyes-on axi respond --action read')),
    'the payload names the command that answers it',
  );
  assert.ok(doc.help.some((line) => line.includes('Nothing outside eyes-on is held up')));

  const db = openDb(env);
  const row = db.get<{ status: string }>('SELECT status FROM checks WHERE id = ?', doc.check_id);
  db.close();
  assert.equal(row?.status, 'must_read', 'the park is recorded, not merely printed');
});

test('acceptance: a waiver records the decision, the reason and who gave it', async (t) => {
  const repo = parkedRepo('gate-waive');
  const env = sandboxEnv('gate-waive');
  await initRepo(t, repo, env);

  const check = JSON.parse((await captureCli(['check', '--format', 'json'], { cwd: repo.path, env })).out) as CheckDoc;

  const reason = 'the replica count is the only line that changed and it was agreed in the deploy review';
  const result = await captureCli(['axi', 'respond', '--action', 'waive', '--reason', reason, '--format', 'json'], {
    cwd: repo.path,
    env: { ...env, EYES_ON_ACTOR: 'crewmate' },
  });
  const doc = JSON.parse(result.out) as RespondDoc;

  assert.equal(result.code, EXIT_OK);
  assert.equal(doc.check_id, check.check_id);
  assert.equal(doc.gate_was, 'must_read');
  assert.equal(doc.gate, 'none');
  assert.equal(doc.status, 'done');
  assert.equal(doc.action, 'waive');
  assert.equal(doc.reason, reason);
  assert.equal(doc.decided_by, 'crewmate');

  const db = openDb(env);
  const decision = db.get<{ action: string; reason: string; decided_by: string }>(
    'SELECT action, reason, decided_by FROM decisions WHERE check_id = ?',
    check.check_id,
  );
  const row = db.get<{ status: string }>('SELECT status FROM checks WHERE id = ?', check.check_id);
  db.close();
  assert.equal(decision?.action, 'waive');
  assert.equal(decision?.reason, reason, 'the reason is stored whole, as a durable record');
  assert.equal(decision?.decided_by, 'crewmate');
  assert.equal(row?.status, 'done', 'answering releases the park');
});

test('a decision answers the rules it was shown, so a rule that appears later parks the change again', async (t) => {
  // A decision is evidence about the rules somebody was given. Answering a run
  // no rule matched is supported and recorded - but it must not pre-answer a
  // rule that only becomes visible when the default branch gains one, or the
  // pull request publishes a waiver against a rule nobody was ever shown.
  const repo = tempRepo('gate-newrule');
  repo.commitFiles('chore: nothing to protect yet', { 'src/a.ts': 'export const a = 1;\n' });
  repo.git(['checkout', '-q', '-b', 'work']);
  repo.commitFiles('chore: bump replicas', { 'deploy/values.yaml': 'replicas: 4\n' });
  const env = sandboxEnv('gate-newrule');
  await initRepo(t, repo, env);

  const before = JSON.parse((await captureCli(['check', '--format', 'json'], { cwd: repo.path, env })).out) as CheckDoc;
  assert.equal(before.gate, 'none', 'no rule has been written yet');

  const answered = await captureCli(['axi', 'respond', '--action', 'waive', '--reason', 'nothing here needs reading', '--format', 'json'], {
    cwd: repo.path,
    env,
  });
  assert.equal(answered.code, EXIT_OK);
  const answer = JSON.parse(answered.out) as RespondDoc & { answered_hits: unknown[] };
  assert.deepEqual(answer.answered_hits, [], 'the decision was given against no rule at all');

  // The rule lands on the default branch. base..head does not move - the
  // merge-base is still where `work` left `main` - so this is the same check.
  repo.checkout('main');
  repo.commitFiles('chore: protect the deployment', { '.eyes-on.yml': CONFIG });
  repo.checkout('work');

  const after = JSON.parse((await captureCli(['check', '--format', 'json'], { cwd: repo.path, env })).out) as CheckDoc;
  assert.equal(after.check_id, before.check_id, 'the same change, so the same check');
  assert.equal(after.band, 'pelna');
  assert.equal(after.gate, 'must_read', 'the rule was never answered, so it parks');
  assert.equal(after.decision, null, 'and the earlier waiver is not attributed to it');

  const db = openDb(env);
  const parked = db.get<{ status: string }>('SELECT status FROM checks WHERE id = ?', after.check_id);
  db.close();
  assert.equal(parked?.status, 'must_read');

  // Answering the rule that actually fired releases it, and stays released.
  await captureCli(['axi', 'respond', '--action', 'read', '--format', 'json'], { cwd: repo.path, env });
  const released = JSON.parse((await captureCli(['check', '--format', 'json'], { cwd: repo.path, env })).out) as CheckDoc;
  assert.equal(released.gate, 'none');
  assert.equal(released.decision, 'read');
});

test('answering the gate records a decision without making an unreadable configuration readable', async (t) => {
  // A check recorded `unverified` was scored with no hard rules at all, so its
  // band is a lower bound. Answering the gate says what a person decided; it
  // says nothing about the configuration eyes-on still cannot read.
  const repo = tempRepo('gate-unverified');
  repo.commitFiles('chore: a configuration nobody can read', {
    '.eyes-on.yml': 'schema: eyes-on/v1\nthresholds: { read_fragments: 80, full_review: 20 }\n',
    'src/a.ts': 'export const a = 1;\n',
  });
  repo.git(['checkout', '-q', '-b', 'work']);
  repo.commitFiles('feat: another module', { 'src/b.ts': 'export const b = 2;\n' });
  const env = sandboxEnv('gate-unverified');
  await initRepo(t, repo, env);

  const check = JSON.parse((await captureCli(['check', '--format', 'json'], { cwd: repo.path, env })).out) as CheckDoc & {
    config_state: string;
  };
  assert.equal(check.config_state, 'unverified');

  const result = await captureCli(['axi', 'respond', '--action', 'read', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as RespondDoc & { unverified: boolean; help: string[] };
  assert.equal(result.code, EXIT_OK);
  assert.equal(doc.action, 'read', 'the decision is still recorded');
  assert.equal(doc.status, 'unverified', 'the payload reports the status the row was left in');
  assert.equal(doc.unverified, true);
  // Not evaluated and not matched are different states with different remedies,
  // and one document may not claim both.
  assert.ok(doc.help.some((line) => line.includes('no hard rule could be evaluated')));
  assert.ok(
    !doc.help.some((line) => line.includes('no hard rule matched it')),
    'a run whose rules were never evaluated cannot report that none matched',
  );

  const db = openDb(env);
  const row = db.get<{ status: string }>('SELECT status FROM checks WHERE id = ?', check.check_id);
  const decision = db.get<{ action: string }>('SELECT action FROM decisions WHERE check_id = ?', check.check_id);
  db.close();
  assert.equal(decision?.action, 'read');
  assert.equal(row?.status, 'unverified', 'the record that no hard rule was evaluated survives the answer');

  const status = await captureCli(['status', '--format', 'md'], { cwd: repo.path, env });
  assert.match(status.out, /no hard rule was evaluated and this band is a lower bound/);
});

test('a waiver with no reason is refused, and nothing is recorded', async (t) => {
  const repo = parkedRepo('gate-noreason');
  const env = sandboxEnv('gate-noreason');
  await initRepo(t, repo, env);
  await captureCli(['check', '--format', 'json'], { cwd: repo.path, env });

  const result = await captureCli(['axi', 'respond', '--action', 'waive'], { cwd: repo.path, env });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.out, /a waiver has to say why/);

  const empty = await captureCli(['axi', 'respond', '--action', 'waive', '--reason', '   '], { cwd: repo.path, env });
  assert.equal(empty.code, EXIT_USAGE, 'whitespace is not a reason');

  const db = openDb(env);
  const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM decisions');
  db.close();
  assert.equal(count?.n, 0);
});

test('an unknown action is a usage error naming the two that exist', async (t) => {
  const repo = parkedRepo('gate-action');
  const env = sandboxEnv('gate-action');
  await initRepo(t, repo, env);
  await captureCli(['check'], { cwd: repo.path, env });

  const missing = await captureCli(['axi', 'respond'], { cwd: repo.path, env });
  assert.equal(missing.code, EXIT_USAGE);
  assert.match(missing.out, /respond needs --action/);

  const wrong = await captureCli(['axi', 'respond', '--action', 'ignore'], { cwd: repo.path, env });
  assert.equal(wrong.code, EXIT_USAGE);
  assert.match(wrong.out, /unknown action ignore/);
  assert.match(wrong.out, /--action read/);
  assert.match(wrong.out, /--action waive/);
});

test('re-running check after an answer does not reopen a gate somebody already closed', async (t) => {
  const repo = parkedRepo('gate-reopen');
  const env = sandboxEnv('gate-reopen');
  await initRepo(t, repo, env);

  await captureCli(['check'], { cwd: repo.path, env });
  await captureCli(['axi', 'respond', '--action', 'read'], { cwd: repo.path, env });

  const again = JSON.parse((await captureCli(['check', '--format', 'json'], { cwd: repo.path, env })).out) as CheckDoc;
  assert.equal(again.gate, 'none');
  assert.equal(again.decision, 'read');
  assert.equal(again.band, 'pelna', 'the band is still what the rule made it');

  const db = openDb(env);
  const row = db.get<{ status: string }>('SELECT status FROM checks WHERE id = ?', again.check_id);
  db.close();
  assert.equal(row?.status, 'done');
});

test('a second answer is appended, because a change can be waived and then read', async (t) => {
  const repo = parkedRepo('gate-append');
  const env = sandboxEnv('gate-append');
  await initRepo(t, repo, env);
  await captureCli(['check'], { cwd: repo.path, env });

  await captureCli(['axi', 'respond', '--action', 'waive', '--reason', 'shipping before the window closes'], {
    cwd: repo.path,
    env,
  });
  const second = JSON.parse(
    (await captureCli(['axi', 'respond', '--action', 'read', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as RespondDoc;

  assert.equal(second.previous_action, 'waive');
  assert.equal(second.decisions.length, 2);
  assert.deepEqual(
    second.decisions.map((decision) => decision.action),
    ['waive', 'read'],
  );
  assert.match(second.decisions[0]?.reason ?? '', /window closes/);
});

test('acceptance: an unanswered gate blocks nothing but the eyes-on run', async (t) => {
  const repo = parkedRepo('gate-blocks');
  const env = sandboxEnv('gate-blocks');
  await initRepo(t, repo, env);

  const check = await captureCli(['check', '--format', 'json'], { cwd: repo.path, env });
  assert.equal(check.code, EXIT_OK);
  assert.equal((JSON.parse(check.out) as CheckDoc).gate, 'must_read');

  // Every other command keeps working while the gate is open, and every one of
  // them exits 0. The only non-zero exit in the product is --strict, and that
  // is about the band rather than about the gate.
  for (const argv of [['status'], ['rules', '--check'], ['spotlight', '--no-model'], ['why', '--top', '3'], ['doctor']]) {
    const result = await captureCli([...argv, '--format', 'json'], { cwd: repo.path, env });
    assert.equal(result.code, EXIT_OK, `\`eyes-on ${argv.join(' ')}\` still works with the gate open`);
  }

  const strict = await captureCli(['check', '--strict', '--format', 'json'], { cwd: repo.path, env });
  assert.equal(strict.code, EXIT_ERROR, '--strict is still the only door out of exit 0');
});

test('responding to a change nobody assessed says so rather than recording a decision about nothing', async (t) => {
  const repo = parkedRepo('gate-nocheck');
  const env = sandboxEnv('gate-nocheck');
  await initRepo(t, repo, env);

  const result = await captureCli(['axi', 'respond', '--action', 'read'], { cwd: repo.path, env });
  assert.equal(result.code, EXIT_ERROR);
  assert.match(result.out, /no eyes-on check/);
  assert.match(result.out, /Run `eyes-on check` on this change first/);
});

test('abort says what eyes-on actually has, rather than promising a later stage', async (t) => {
  const repo = parkedRepo('gate-abort');
  const env = sandboxEnv('gate-abort');
  await initRepo(t, repo, env);

  const result = await captureCli(['axi', 'abort'], { cwd: repo.path, env });
  assert.equal(result.code, EXIT_USAGE);
  assert.match(result.out, /no in-flight run to abort/);
  assert.match(result.out, /axi respond --action read/);
  assert.doesNotMatch(result.out, /unknown axi subcommand/);

  // And the command is on the surface it answers from. An agent working from
  // the scope report's Appendix C.1 asks for `abort`, and a refusal with a
  // reason is only better than a stub if the surface admits the command
  // exists - `help` and the generated skill are built from the same registry.
  const usage = await captureCli(['axi', '--help'], { cwd: repo.path, env });
  assert.match(usage.out, /\babort\b/, 'the axi usage string omits a subcommand the dispatcher answers');
});
