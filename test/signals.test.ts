import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bandFor,
  bandLabel,
  maxScore,
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
import { driftSignalValue } from '../src/spot/drift.js';

test('the weights, the saturation constants and the thresholds are the report\'s', () => {
  // Section 5: fix history 0.30 / churn 0.20 / size 0.20 / spread 0.10 /
  // no test 0.15 / recency 0.05 / drift 0.00 -> 0.20, thresholds 35 and 65.
  // Drift moved to its stage 2 weight when P4 started measuring it.
  assert.deepEqual(DEFAULT_WEIGHTS, {
    fix_history: 0.3,
    churn: 0.2,
    size: 0.2,
    spread: 0.1,
    no_test: 0.15,
    recency: 0.05,
    drift: 0.2,
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

  // The report keeps the thresholds at 35 and 65 while adding 0.20 for drift,
  // so the six history signals still reach exactly 100 between them and drift
  // adds on top of that. The maximum is 120, and `maxScore` - not a literal
  // 100 - is what every rendering divides by.
  const withoutDrift = SIGNAL_NAMES.filter((name) => name !== 'drift').reduce(
    (sum, name) => sum + DEFAULT_WEIGHTS[name],
    0,
  );
  assert.equal(Math.round(withoutDrift * 100), 100);
  // The ceiling the weights allow. S7 reaches 18 of its 20 in practice; this
  // is the denominator a rendering divides by, not a score anybody will see.
  assert.equal(maxScore(defaultRepoConfig()), 120);
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

test('a change that saturates the six history signals scores 100, and drift adds on top of that', () => {
  const config = defaultRepoConfig();
  const history = scoreSignals(
    raw({ fix_history: 99, churn: 99, size: 9999, spread: 99, no_test: 1, recency: 30 }),
    config,
  );
  assert.equal(history.score, 100, 'the six signals computed from history still total exactly 100');
  assert.equal(history.band, 'pelna');

  const everything = scoreSignals(
    raw({ fix_history: 99, churn: 99, size: 9999, spread: 99, no_test: 1, recency: 30, drift: driftSignalValue(5) }),
    config,
  );
  // Drift is weighted 0.20 from stage 2 and the report leaves the thresholds
  // where they were, so a fully drifted change goes above 100 rather than
  // displacing the other six. It reaches 118 rather than the 120 the weights
  // allow, because S7's raw value tops out at 4 against a saturation constant
  // of 5 - see the drift test below for why that direction was chosen.
  assert.equal(everything.score, 118);
  assert.equal(everything.band, 'pelna');

  const nothing = scoreSignals(raw({}), config);
  assert.equal(nothing.score, 0);
  assert.equal(nothing.band, 'auto');
  assert.match(rationale(nothing)[0] ?? '', /no signal moved the score/);
});

test('the drift signal is scored at 0.20 and an unmeasured drift contributes nothing', () => {
  const config = defaultRepoConfig();
  const scored = scoreSignals(raw({ drift: 4 }), config);
  const drift = scored.signals.find((signal) => signal.name === 'drift');
  assert.ok(drift, 'drift is one of the seven signals');
  assert.equal(drift.weight, 0.2);
  // 4 is the raw S7 value of a grade of 5: the grade minus the aligned 1, so a
  // change that does exactly what it said adds nothing for having been asked.
  //
  // The consequence is that S7 tops out at 18 of the 20 points its weight
  // allows, because the report's saturation constant for drift is 5 and the
  // raw value can only reach 4. That is the deliberate direction of the error:
  // the alternative - feeding the grade itself - would put 8 points on every
  // change whose drift was measured and found to be 1, which is a change that
  // did exactly what it said.
  assert.equal(drift.raw, 4);
  assert.equal(scored.score, 18);

  // The unmeasured case, which is every run without an intent and every run
  // with --no-model.
  assert.equal(scoreSignals(raw({}), config).score, 0);
});

test('an aligned change is not charged for having had its drift measured', () => {
  const config = defaultRepoConfig();
  // driftSignalValue(1) is 0: grade 1 means the diff does what the intent said.
  assert.equal(driftSignalValue(1), 0);
  assert.equal(driftSignalValue(5), 4);
  assert.equal(driftSignalValue(null), 0);
  assert.equal(scoreSignals(raw({ drift: driftSignalValue(1) }), config).score, 0);
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
