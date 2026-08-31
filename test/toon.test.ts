import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeScalar, encodeToon } from '../src/cli/toon.js';

test('scalars are quoted only when a bare form would be misread', () => {
  assert.equal(encodeScalar('running'), 'running');
  assert.equal(encodeScalar('/Users/a/.eyes-on'), '/Users/a/.eyes-on');
  assert.equal(encodeScalar('a, b'), '"a, b"');
  assert.equal(encodeScalar('how: like this'), '"how: like this"');
  assert.equal(encodeScalar(''), '""');
  assert.equal(encodeScalar(' padded '), '" padded "');
  // A bare `42` or `true` would decode as a number or a boolean.
  assert.equal(encodeScalar('42'), '"42"');
  assert.equal(encodeScalar('true'), '"true"');
  assert.equal(encodeScalar(42), '42');
  assert.equal(encodeScalar(true), 'true');
  assert.equal(encodeScalar(null), 'null');
  assert.equal(encodeScalar('say "hi"'), '"say \\"hi\\""');
});

test('objects, scalar arrays and object tables render in the documented shapes', () => {
  const out = encodeToon({
    daemon: 'running',
    pid: 42,
    help: ['first', 'second, with a comma'],
    repos: [
      { id: 'aaa', path: '/one', refs: 3 },
      { id: 'bbb', path: '/two', refs: 0 },
    ],
    nested: { a: 1, b: { c: 'deep' } },
    empty: [],
  });
  assert.equal(
    out,
    [
      'daemon: running',
      'pid: 42',
      'help[2]: first,"second, with a comma"',
      'repos[2]{id,path,refs}:',
      '  aaa,/one,3',
      '  bbb,/two,0',
      'nested:',
      '  a: 1',
      '  b:',
      '    c: deep',
      'empty[0]:',
      '',
    ].join('\n'),
  );
});

test('a table header is the union of the rows, so no field is silently dropped', () => {
  const out = encodeToon({ rows: [{ a: 1 }, { b: 2 }] });
  assert.equal(out, 'rows[2]{a,b}:\n  1,\n  ,2\n');
});
