import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { captureCli, sandboxEnv, tempRepo, type TempRepo } from './helpers.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../src/cli/output.js';
import { Database } from '../src/db/db.js';

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
});
