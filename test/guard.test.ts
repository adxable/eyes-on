import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { classify } from '../src/core/guard.js';
import { tempDir } from './helpers.js';

test('NO_MISTAKES_GATE=1 marks the process as a pipeline descendant', () => {
  const verdict = classify({ env: { NO_MISTAKES_GATE: '1' }, cwd: '/tmp' });
  assert.equal(verdict.insideGate, true);
  assert.equal(verdict.reason, 'gate-env');
});

test('a working directory under the no-mistakes worktree root is detected too', () => {
  const nmHome = tempDir('nm-home');
  const inside = join(nmHome, 'worktrees', 'abc', 'run-1');
  mkdirSync(inside, { recursive: true });
  const verdict = classify({ env: { NM_HOME: nmHome }, cwd: inside });
  assert.equal(verdict.insideGate, true);
  assert.equal(verdict.reason, 'gate-cwd');
});

test('an ordinary clone is not inside a gate', () => {
  const nmHome = tempDir('nm-home-clean');
  mkdirSync(join(nmHome, 'worktrees'), { recursive: true });
  const elsewhere = tempDir('clone');
  assert.equal(classify({ env: { NM_HOME: nmHome }, cwd: elsewhere }).insideGate, false);
});

test('a sibling directory whose name merely starts the same is not inside', () => {
  const nmHome = tempDir('nm-home-sibling');
  const decoy = join(nmHome, 'worktrees-not-really');
  mkdirSync(decoy, { recursive: true });
  mkdirSync(join(nmHome, 'worktrees'), { recursive: true });
  assert.equal(classify({ env: { NM_HOME: nmHome }, cwd: decoy }).insideGate, false);
});
