import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandFor,
  bandLabel,
  rationale,
  saturate,
  scoreSignals,
  SIGNAL_UNITS,
  type RawSignals,
} from '../src/risk/signals.js';
import {
  DEFAULT_SATURATION,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  defaultRepoConfig,
  SIGNAL_NAMES,
} from '../src/risk/repoconfig.js';

test('the weights, the saturation constants and the thresholds are the report\'s', () => {
  // Section 5: fix history 0.30 / churn 0.20 / size 0.20 / spread 0.10 /
  // no test 0.15 / recency 0.05 / drift 0.00, thresholds 35 and 65.
  assert.deepEqual(DEFAULT_WEIGHTS, {
    fix_history: 0.3,
    churn: 0.2,
    size: 0.2,
    spread: 0.1,
    no_test: 0.15,
    recency: 0.05,
    drift: 0,
  });
  assert.deepEqual(DEFAULT_SATURATION, {
    fix_history: 5,
    churn: 20,
    size: 400,
    spread: 12,
    no_test: 1,
    recency: 30,
    drift: 5,
  });
  assert.deepEqual(DEFAULT_THRESHOLDS, { read_fragments: 35, full_review: 65 });

  const total = Object.values(DEFAULT_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  // A change that saturates every signal must score exactly 100, or the bands
  // stop meaning what the thresholds say they mean.
  assert.equal(Math.round(total * 100), 100);
});

test('the saturation curve is min(1, ln(1+x)/ln(1+K))', () => {
  for (const [x, k] of [
    [0, 5],
    [1, 5],
    [3, 20],
    [17, 400],
    [400, 400],
  ] as [number, number][]) {
    assert.equal(saturate(x, k), Math.min(1, Math.log1p(x) / Math.log1p(k)));
  }
  assert.equal(saturate(0, 5), 0);
  assert.equal(saturate(5, 5), 1);
  // Past saturation it stays at one rather than growing.
  assert.equal(saturate(500, 5), 1);
  assert.equal(saturate(-3, 5), 0);
});

test('bands break at 35 and 65, on the threshold itself', () => {
  const thresholds = DEFAULT_THRESHOLDS;
  assert.equal(bandFor(0, thresholds), 'auto');
  assert.equal(bandFor(34, thresholds), 'auto');
  assert.equal(bandFor(35, thresholds), 'wskazane');
  assert.equal(bandFor(64, thresholds), 'wskazane');
  assert.equal(bandFor(65, thresholds), 'pelna');
  assert.equal(bandFor(100, thresholds), 'pelna');
});

test('band identifiers stay the report\'s machine contract, with an English label beside them', () => {
  // Appendix C.4 pins these into the pull-request comment marker, which stage 2
  // and stage 3 parse. Renaming them here would break that contract silently.
  assert.equal(bandLabel('auto'), 'no reading required');
  assert.equal(bandLabel('wskazane'), 'read the indicated fragments');
  assert.equal(bandLabel('pelna'), 'full review');
});

function raw(values: Partial<Record<keyof RawSignals, number>>): RawSignals {
  const out = {} as RawSignals;
  for (const name of SIGNAL_NAMES) {
    out[name] = { value: values[name] ?? 0, from: null };
  }
  return out;
}

test('a change that saturates everything scores 100 and one that moves nothing scores 0', () => {
  const config = defaultRepoConfig();
  const everything = scoreSignals(
    raw({ fix_history: 99, churn: 99, size: 9999, spread: 99, no_test: 1, recency: 30, drift: 5 }),
    config,
  );
  // drift is weighted 0.00 at stage 1, so a saturated change tops out at 100
  // exactly - the missing signal is the one that carries no weight yet.
  assert.equal(everything.score, 100);
  assert.equal(everything.band, 'pelna');

  const nothing = scoreSignals(raw({}), config);
  assert.equal(nothing.score, 0);
  assert.equal(nothing.band, 'auto');
  assert.match(rationale(nothing)[0] ?? '', /no signal moved the score/);
});

test('the drift signal is present, measured and weighted zero rather than absent', () => {
  const config = defaultRepoConfig();
  const scored = scoreSignals(raw({ drift: 5 }), config);
  const drift = scored.signals.find((signal) => signal.name === 'drift');
  assert.ok(drift, 'drift is one of the seven signals even before stage 2 scores it');
  assert.equal(drift.weight, 0);
  assert.equal(drift.contribution, 0);
  assert.equal(scored.score, 0);
});

test('the rationale names the file behind each signal and drops the ones that did nothing', () => {
  const config = defaultRepoConfig();
  const values = raw({ fix_history: 5, size: 400 });
  values.fix_history.from = 'src/hot.ts';
  const lines = rationale(scoreSignals(values, config));
  assert.equal(lines.length, 2, 'only the two signals that moved the score are listed');
  assert.match(lines[0] ?? '', /^fix_history 1\.00 x weight 0\.30 = 30 points \(src\/hot\.ts\)/);
  assert.match(lines[1] ?? '', /^size 1\.00 x weight 0\.20 = 20 points/);
});

test('the no-test share is rendered as a share, not as a count', () => {
  const config = defaultRepoConfig();
  const lines = rationale(scoreSignals(raw({ no_test: 0.5 }), config));
  assert.match(lines[0] ?? '', /50% of changed code files had no test changed alongside them/);
});

test('every signal has a unit sentence, so no report ever prints a bare number', () => {
  for (const name of SIGNAL_NAMES) {
    assert.ok((SIGNAL_UNITS[name] ?? '').length > 0, `${name} has no unit`);
  }
});
