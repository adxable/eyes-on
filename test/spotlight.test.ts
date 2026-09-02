import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { captureCli, sandboxEnv, stubAgent, tempDir, tempRepo, type StubAgent, type TempRepo } from './helpers.js';
import { EXIT_OK } from '../src/cli/output.js';
import { parseHunks, type Hunk } from '../src/spot/hunks.js';
import {
  blamedHunks,
  capPerFile,
  hunkKey,
  rankHunks,
  BLAMED_FACTOR,
  HARD_RULE_FACTOR,
  MIN_FILE_RISK,
  NO_TEST_FACTOR,
  type Candidate,
} from '../src/spot/rank.js';
import { clampN, selectSpotlight, validate } from '../src/spot/spotlight.js';
import { spotlightPrompt } from '../src/spot/prompt.js';
import { RepoReader } from '../src/git/reader.js';
import { Database } from '../src/db/db.js';

/**
 * The fragment ranking, both stages.
 *
 * The acceptance condition this file carries is the emergency path: **`--no-model`
 * returns stage one and does not call a model once.** It is asserted against a
 * fake agent that records every invocation, so "did not call it" is the absence
 * of a file this suite would otherwise have written, not a promise in a comment.
 */

function hunk(overrides: Partial<Hunk> & { path: string }): Hunk {
  return {
    deleted: false,
    created: false,
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
    anchor: 1,
    added: 1,
    removed: 0,
    text: '@@ -1 +1 @@\n+x',
    ...overrides,
  };
}

function rank(hunks: readonly Hunk[], overrides: Partial<Parameters<typeof rankHunks>[0]> = {}): Candidate[] {
  return rankHunks({
    hunks,
    fileRisk: new Map(),
    ruleFiles: new Set(),
    untested: new Set(),
    blamed: new Set(),
    maxHunks: 12,
    maxPerFile: 3,
    ...overrides,
  });
}

test('the stage 1 weight is the product the report specifies, term by term', () => {
  const plain = hunk({ path: 'src/a.ts', added: 6, removed: 4 });
  const risk = new Map([['src/a.ts', 50]]);

  const base = rank([plain], { fileRisk: risk })[0];
  assert.ok(base);
  assert.equal(base.size, 10);
  assert.equal(base.file_risk, 50);
  assert.equal(base.weight, 500, 'file risk x hunk size, with no multiplier');

  const withRule = rank([plain], { fileRisk: risk, ruleFiles: new Set(['src/a.ts']) })[0];
  assert.equal(withRule?.weight, 500 * HARD_RULE_FACTOR);
  assert.equal(withRule?.hard_rule, true);

  const withBlame = rank([plain], { fileRisk: risk, blamed: new Set([hunkKey(plain)]) })[0];
  assert.equal(withBlame?.weight, 500 * BLAMED_FACTOR);

  const withoutTest = rank([plain], { fileRisk: risk, untested: new Set(['src/a.ts']) })[0];
  assert.equal(withoutTest?.weight, 500 * NO_TEST_FACTOR);

  const everything = rank([plain], {
    fileRisk: risk,
    ruleFiles: new Set(['src/a.ts']),
    blamed: new Set([hunkKey(plain)]),
    untested: new Set(['src/a.ts']),
  })[0];
  assert.equal(everything?.weight, 500 * HARD_RULE_FACTOR * BLAMED_FACTOR * NO_TEST_FACTOR);
});

test('a file the history has never seen still ranks, on a floor rather than on zero', () => {
  // The formula is a product, so a risk of 0 would zero every fragment of a
  // brand-new file - which is the one place history cannot help at all.
  const ranked = rank([hunk({ path: 'src/new.ts', created: true, added: 40 })]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.file_risk, MIN_FILE_RISK);
  assert.equal(ranked[0]?.weight, 40);
});

test('a hunk that changed nothing is not a fragment', () => {
  assert.deepEqual(rank([hunk({ path: 'src/a.ts', added: 0, removed: 0 })]), []);
});

test('no file may fill the candidate set, and the cap gives its places back when nobody wants them', () => {
  const wide = Array.from({ length: 6 }, (_, index) =>
    hunk({ path: 'src/hot.ts', newStart: index * 100, anchor: index * 100, added: 50 - index }),
  ).concat([hunk({ path: 'src/cold.ts', anchor: 7, added: 1 })]);

  const capped = rank(wide, { fileRisk: new Map([['src/hot.ts', 90], ['src/cold.ts', 10]]), maxHunks: 4, maxPerFile: 3 });
  assert.equal(capped.filter((candidate) => candidate.file === 'src/hot.ts').length, 3);
  assert.ok(
    capped.some((candidate) => candidate.file === 'src/cold.ts'),
    'the quiet file gets a place a reviewer would otherwise never be sent to',
  );

  // A change that touches one file has nothing to diversify into, so the cap
  // must not decide the answer for it.
  const oneFile = rank(wide.slice(0, 6), { fileRisk: new Map([['src/hot.ts', 90]]), maxHunks: 5, maxPerFile: 3 });
  assert.equal(oneFile.length, 5, 'the shortfall is filled from what the cap held back');
});

test('capPerFile takes the best first and never exceeds the limit', () => {
  const candidates: Candidate[] = ['a', 'a', 'a', 'b', 'b'].map((file, index) => ({
    file: `${file}.ts`,
    line: index,
    weight: 100 - index,
    file_risk: 1,
    size: 1,
    hard_rule: false,
    previously_blamed: false,
    no_test: false,
    created: false,
    deleted: false,
    text: '',
  }));
  const taken = capPerFile(candidates, 4, 2);
  assert.equal(taken.length, 4);
  assert.equal(taken.filter((candidate) => candidate.file === 'a.ts').length, 2);
  assert.equal(taken[0]?.weight, 100, 'ordering is by weight, not by file');
});

test('the number of fragments asked for is brought into the report\'s three-to-five range', () => {
  assert.equal(clampN(1), 3);
  assert.equal(clampN(4), 4);
  assert.equal(clampN(50), 5);
  assert.equal(clampN(Number.NaN), 5);
});

test('a hunk whose lines a past fix already blamed is recognised across the coordinate drift', () => {
  const repo = tempRepo('blamed');
  const introduced = repo.commitFiles('feat: write the line', {
    'src/a.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
  });
  // A later commit moves the lines down, so any line number SZZ recorded for
  // the original is wrong by the time the change under assessment is written.
  repo.commitFiles('chore: add a header', {
    'src/a.ts': '// header\n// header\nconst a = 1;\nconst b = 2;\nconst c = 3;\n',
  });
  const base = repo.commitFiles('chore: settle', { 'src/other.ts': 'export const other = 1;\n' });
  const head = repo.commitFiles('feat: change the blamed line', {
    'src/a.ts': '// header\n// header\nconst a = 99;\nconst b = 2;\nconst c = 3;\n',
  });

  const reader = new RepoReader({ clonePath: repo.path, mirrorPath: join(tempDir('blamed-mirror'), 'absent.git') });
  const hunks = parseHunks(reader.rangePatch(base, head));
  assert.ok(hunks.length > 0);

  const hit = blamedHunks(reader, base, hunks, new Set([introduced]));
  assert.equal(hit.size, 1, 'the hunk touches a line the introducing commit wrote');
  assert.ok(hit.has(hunkKey(hunks[0] as Hunk)));

  // A commit nobody blamed leaves the multiplier off.
  assert.equal(blamedHunks(reader, base, hunks, new Set(['0'.repeat(40)])).size, 0);
  assert.equal(blamedHunks(reader, base, hunks, new Set()).size, 0);
});

test('the prompt forbids style outright, and says so in the terms the measurement uses', () => {
  const prompt = spotlightPrompt({
    candidates: rank([hunk({ path: 'src/a.ts', added: 3 })]),
    n: 5,
    intent: null,
    band: 'wskazane',
    score: 40,
  });
  assert.match(prompt, /NEVER comment on style, formatting, naming/);
  assert.match(prompt, /over-report style by 328%/);
  assert.match(prompt, /correctness by 42\.6% and security by 89\.5%/);
  assert.match(prompt, /"spotlight":/, 'the answer shape is stated, not implied');
});

test('a model fragment is kept only when it names a candidate of this change', () => {
  const candidates = rank([
    hunk({ path: 'src/a.ts', anchor: 12, added: 4 }),
    hunk({ path: 'src/b.ts', anchor: 30, added: 4 }),
  ]);
  const parsed = validate(
    JSON.stringify({
      spotlight: [
        { file: 'src/a.ts', line: 12, category: 'correctness', why: 'check the new branch' },
        { file: 'src/nowhere.ts', line: 1, category: 'correctness', why: 'invented' },
        { file: 'src/b.ts', line: 900, category: 'security', why: 'nowhere near a fragment' },
        { file: 'src/a.ts', line: 12, category: 'correctness', why: 'the same one twice' },
      ],
    }),
    candidates,
    5,
  );
  assert.equal(parsed.spots.length, 1);
  assert.equal(parsed.spots[0]?.file, 'src/a.ts');
  assert.equal(parsed.spots[0]?.category, 'correctness');
  assert.equal(parsed.rejected, 3);
  assert.ok(parsed.reasons.some((reason) => reason.includes('src/nowhere.ts')));
});

test('a category outside the taxonomy is reported as unknown rather than mapped to the nearest one', () => {
  const candidates = rank([hunk({ path: 'src/a.ts', anchor: 1, added: 4 })]);
  const parsed = validate(
    JSON.stringify({ spotlight: [{ file: 'src/a.ts', line: 1, category: 'nitpick', why: 'something' }] }),
    candidates,
    5,
  );
  assert.equal(parsed.spots[0]?.category, null);
});

test('a model answer wrapped in prose still parses, and one that is not JSON leaves stage one standing', () => {
  const candidates = rank([hunk({ path: 'src/a.ts', anchor: 1, added: 4 })]);
  const wrapped = validate(
    'Here you go:\n```json\n{"spotlight":[{"file":"src/a.ts","line":1,"category":"security","why":"check the input"}]}\n```\nHope that helps.',
    candidates,
    5,
  );
  assert.equal(wrapped.spots.length, 1);

  const nonsense = selectSpotlight({
    candidates,
    n: 5,
    intent: null,
    score: 10,
    band: 'auto',
    model: { command: ['definitely-not-an-agent'], allowAnyCommand: false },
  });
  assert.equal(nonsense.stage, 1);
  assert.equal(nonsense.model.state, 'refused');
  assert.equal(nonsense.spots.length, 1);
  assert.equal(nonsense.spots[0]?.source, 'rank');
  assert.equal(nonsense.spots[0]?.category, null, 'stage one does not invent a category');
});

test('an empty model.command is the repository asking for stage one, not a failure', () => {
  const candidates = rank([hunk({ path: 'src/a.ts', anchor: 1, added: 4 })]);
  const result = selectSpotlight({
    candidates,
    n: 5,
    intent: null,
    score: 10,
    band: 'auto',
    model: { command: [], allowAnyCommand: false },
  });
  assert.equal(result.model.state, 'skipped');
  assert.match('detail' in result.model ? result.model.detail : '', /empty/);
});

// --- end to end, through the CLI -------------------------------------------

/** A repository with a hot file, a quiet one, and a config naming the stub. */
function repoWithModel(agent: StubAgent | null): TempRepo {
  const repo = tempRepo('spotlight');
  const config = [
    'schema: eyes-on/v1',
    'hard_rules:',
    '  - glob: "deploy/**"',
    '    why: "deployment configuration - a mistake costs a machine, not a test"',
    ...(agent ? ['model:', `  command: ["${agent.command[0] as string}"]`] : []),
    '',
  ].join('\n');

  repo.commitFiles('chore: configure eyes-on', { '.eyes-on.yml': config });
  for (let index = 0; index < 4; index += 1) {
    repo.commitFiles(`feat: work ${index}`, { 'src/hot.ts': `export const hot = ${index};\n` });
    repo.commitFiles(`fix: correct ${index}`, { 'src/hot.ts': `export const hot = ${index}0;\n` });
  }
  repo.commitFiles('feat: a quiet file', { 'src/quiet.ts': 'export const quiet = 1;\n' });
  repo.git(['checkout', '-q', '-b', 'work']);
  repo.commitFiles('feat: change several things', {
    'src/hot.ts': `${Array.from({ length: 12 }, (_, index) => `export const hot${index} = ${index};`).join('\n')}\n`,
    'src/quiet.ts': 'export const quiet = 2;\nexport const quieter = 3;\n',
    'deploy/values.yaml': 'replicas: 4\n',
  });
  return repo;
}

async function initRepo(t: TestContext, repo: TempRepo, env: Record<string, string>): Promise<void> {
  await captureCli(['init'], { cwd: repo.path, env });
  t.after(async () => {
    await captureCli(['daemon', 'stop'], { cwd: repo.path, env });
  });
}

interface SpotlightDoc {
  stage: number;
  model_state: string;
  model_detail: string;
  candidates_considered: number;
  spotlight: { file: string; line: number; category: string | null; why: string; source: string }[];
  candidates: { file: string; hard_rule: boolean; weight: number }[];
  gate: string;
  exit_code: number;
  rejected_fragments: number;
}

test('acceptance: --no-model returns stage 1 and does not call a model once', async (t) => {
  const agent = stubAgent('spot-nomodel', ['{"spotlight":[]}']);
  const repo = repoWithModel(agent);
  const env = sandboxEnv('spot-nomodel');
  await initRepo(t, repo, env);

  const result = await captureCli(['spotlight', '--no-model', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as SpotlightDoc;

  assert.equal(agent.called(), false, 'the emergency path calls nothing');
  assert.equal(result.code, EXIT_OK);
  assert.equal(doc.exit_code, EXIT_OK);
  assert.equal(doc.stage, 1);
  assert.equal(doc.model_state, 'skipped');
  assert.match(doc.model_detail, /--no-model/);
  assert.ok(doc.spotlight.length >= 3, 'stage 1 is a complete answer, not an apology');
  assert.ok(doc.spotlight.every((spot) => spot.source === 'rank'));
  assert.ok(doc.spotlight.every((spot) => spot.category === null));

  // And it is a real ranking: the hard-rule file is among the candidates, with
  // the doubling its rule earns.
  assert.ok(doc.candidates.some((candidate) => candidate.file === 'deploy/values.yaml' && candidate.hard_rule));
});

test('stage 2 picks fragments from stage 1 and each one carries a category and a sentence', async (t) => {
  const answer = JSON.stringify({
    spotlight: [
      { file: 'src/hot.ts', line: 1, category: 'correctness', why: 'check that every renamed export is still referenced' },
      { file: 'deploy/values.yaml', line: 1, category: 'security', why: 'confirm the replica count is deliberate' },
      { file: 'src/quiet.ts', line: 2, category: 'maintainability', why: 'the second export duplicates the first' },
    ],
  });
  const agent = stubAgent('spot-stage2', [answer]);
  const repo = repoWithModel(agent);
  const env = sandboxEnv('spot-stage2');
  await initRepo(t, repo, env);

  const result = await captureCli(['spotlight', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as SpotlightDoc;

  assert.equal(result.code, EXIT_OK);
  assert.equal(doc.stage, 2);
  assert.equal(doc.model_state, 'ok');
  assert.equal(agent.prompts().length, 1, 'the second stage is one call, not one per fragment');
  assert.equal(doc.spotlight.length, 3);
  assert.ok(doc.spotlight.every((spot) => spot.source === 'model'));
  assert.deepEqual(
    doc.spotlight.map((spot) => spot.category).sort(),
    ['correctness', 'maintainability', 'security'],
  );
  assert.ok(doc.candidates_considered <= 12, 'the second stage is given at most twelve candidates');

  // The prompt it was actually given contains the fragments and the style ban.
  const prompt = agent.prompts()[0] ?? '';
  assert.match(prompt, /CANDIDATE FRAGMENTS/);
  assert.match(prompt, /NEVER comment on style/);
  assert.match(prompt, /deploy\/values\.yaml/);

  // The fragments were recorded against the check, which is what `comment`
  // reads and what stage 3's ledger will find.
  const db = Database.open(join(env.EYES_HOME as string, 'state.sqlite'));
  const spots = db.all<{ file: string; category: string; source: string }>('SELECT * FROM spots');
  db.close();
  assert.equal(spots.length, 3);
  assert.ok(spots.every((spot) => spot.source === 'model'));
});

test('a model that answers with nonsense leaves stage 1 standing and still exits 0', async (t) => {
  const agent = stubAgent('spot-garbage', ['I am afraid I cannot help with that.']);
  const repo = repoWithModel(agent);
  const env = sandboxEnv('spot-garbage');
  await initRepo(t, repo, env);

  const result = await captureCli(['spotlight', '--format', 'json'], { cwd: repo.path, env });
  const doc = JSON.parse(result.out) as SpotlightDoc;

  assert.equal(agent.called(), true, 'the model was asked');
  assert.equal(result.code, EXIT_OK, 'a failed second stage is not a failed command');
  assert.equal(doc.stage, 1);
  assert.equal(doc.model_state, 'failed');
  assert.ok(doc.spotlight.length >= 3);
  assert.ok(doc.spotlight.every((spot) => spot.source === 'rank'));
});

test('a fragment naming a file outside the change is dropped and counted, not published', async (t) => {
  const agent = stubAgent('spot-invented', [
    JSON.stringify({
      spotlight: [
        { file: 'src/hot.ts', line: 1, category: 'correctness', why: 'a real one' },
        { file: 'src/does-not-exist.ts', line: 4, category: 'security', why: 'an invented one' },
      ],
    }),
  ]);
  const repo = repoWithModel(agent);
  const env = sandboxEnv('spot-invented');
  await initRepo(t, repo, env);

  const doc = JSON.parse(
    (await captureCli(['spotlight', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as SpotlightDoc;

  assert.equal(doc.rejected_fragments, 1);
  assert.ok(!doc.spotlight.some((spot) => spot.file === 'src/does-not-exist.ts'));
  // Short answers are brought back up to three from the top of stage one, so a
  // model having a bad minute never reads as "there is only one thing here".
  assert.equal(doc.spotlight.length, 3);
  assert.equal(doc.spotlight[0]?.source, 'model');
  assert.ok(doc.spotlight.slice(1).every((spot) => spot.source === 'rank'));
});

test('an agent that is named and not installed gets stage 1 and a reason, not a failure', async (t) => {
  // A path whose basename is a known agent, so the name allow-list passes and
  // the failure is the one under test: the executable is not there.
  const missing = { command: [join(tempDir('spot-missing'), 'nowhere', 'claude')], prompts: () => [], called: () => false };
  const repo = repoWithModel(missing);
  const env = sandboxEnv('spot-missing');
  await initRepo(t, repo, env);

  const doc = JSON.parse(
    (await captureCli(['spotlight', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as SpotlightDoc;

  assert.equal(doc.stage, 1);
  assert.equal(doc.model_state, 'unavailable');
  assert.match(doc.model_detail, /not on PATH/);
  assert.ok(doc.spotlight.length >= 3, 'the ranking is still a complete answer');
});

test('a model.command the repository chose but eyes-on does not know is refused, not executed', async (t) => {
  // `.eyes-on.yml` comes from the default branch, which is the right trust
  // level for deciding which paths need a reviewer and not by itself a reason
  // to execute an arbitrary program a cloned repository names.
  const repo = repoWithModel({ command: ['/bin/sh'], prompts: () => [], called: () => false });
  const env = sandboxEnv('spot-refused');
  await initRepo(t, repo, env);

  const doc = JSON.parse(
    (await captureCli(['spotlight', '--format', 'json'], { cwd: repo.path, env })).out,
  ) as SpotlightDoc;

  assert.equal(doc.stage, 1);
  assert.equal(doc.model_state, 'refused');
  assert.match(doc.model_detail, /not one of the agents eyes-on knows/);
  assert.match(doc.model_detail, /allow_any_command/);
});
