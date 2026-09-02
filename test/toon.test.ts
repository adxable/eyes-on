import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeScalar, encodeToon, ToonEncodeError } from '../src/cli/toon.js';

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

test('a value the encoder cannot render is refused by name, not by a TypeError', () => {
  // A table row is one record of scalar cells, so a row carrying its own list
  // has nowhere to put it. This used to be discovered inside `trim`, and the
  // TypeError reached the agent where a machine payload was promised.
  const nested = { logs: [{ name: 'daemon', lines: ['one', 'two'] }] };
  assert.throws(() => encodeToon(nested), (error: unknown) => {
    assert.ok(error instanceof ToonEncodeError, `refused with ${String(error)}`);
    assert.match(error.message, /logs\[\]\.lines is a list/);
    assert.ok(error.help.length > 0, 'the refusal names what to do about it');
    return true;
  });

  // An empty list in the same position took the other broken branch, `replace`.
  assert.throws(
    () => encodeToon({ logs: [{ name: 'cli', lines: [] }] }),
    (error: unknown) => error instanceof ToonEncodeError,
  );
});
