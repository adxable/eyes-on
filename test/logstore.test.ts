import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { boundCaptureFile, RotatingLog, rotateFileIfOversized } from '../src/core/logstore.js';
import { tempDir } from './helpers.js';

test('the log rotates at the byte bound and keeps exactly the configured backups', () => {
  const path = join(tempDir('logs'), 'daemon.log');
  const log = new RotatingLog(path, { maxBytes: 200, backups: 2 });
  for (let index = 0; index < 60; index += 1) {
    log.write(`line ${index} ${'x'.repeat(20)}`);
  }
  log.close();

  assert.ok(statSync(path).size <= 200, 'the current file stays under the bound');
  assert.ok(existsSync(`${path}.1`));
  assert.ok(existsSync(`${path}.2`));
  assert.ok(!existsSync(`${path}.3`), 'the oldest backup is dropped, not accumulated');
  // .1 is the newest retired segment, so it holds later lines than .2.
  const first = readFileSync(`${path}.1`, 'utf8');
  const second = readFileSync(`${path}.2`, 'utf8');
  assert.ok(first.length > 0 && second.length > 0);
});

test('structured lines carry a timestamp and the event name', () => {
  const path = join(tempDir('logs-json'), 'daemon.log');
  const log = new RotatingLog(path, { maxBytes: 1 << 20, backups: 1 });
  log.log('daemon.started', { pid: 1234 });
  log.close();
  const record = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>;
  assert.equal(record.event, 'daemon.started');
  assert.equal(record.pid, 1234);
  assert.match(String(record.ts), /^\d{4}-\d{2}-\d{2}T/);
});

/**
 * The two log paths eyes-on does not write through `RotatingLog`: the capture
 * files a LaunchAgent opens and keeps open for the life of the job, and the
 * spawn fallback's own file. Both carry the same bound, by the mechanism that
 * actually works for who holds the file.
 */
test('a capture file another process holds open is bounded in place', () => {
  const path = join(tempDir('logs-capture'), 'service.err.log');
  writeFileSync(path, 'x'.repeat(300));
  // The writer is launchd here: it opened the file before the bound was
  // applied, appends to the descriptor, and never reopens it.
  const held = openSync(path, 'a');
  try {
    assert.equal(boundCaptureFile(path, { maxBytes: 200, backups: 2 }), true);
    assert.equal(statSync(path).size, 0, 'the file the writer still holds is what must shrink');

    writeSync(held, 'a later crash trace\n');
    assert.equal(readFileSync(path, 'utf8'), 'a later crash trace\n', 'the holder keeps appending to the same file');

    assert.equal(boundCaptureFile(path, { maxBytes: 200, backups: 2 }), false, 'a file under the bound is left alone');
  } finally {
    closeSync(held);
  }
});

test('a log this process is about to open is retired into the same backup chain', () => {
  const path = join(tempDir('logs-spawn'), 'daemon.out.log');
  writeFileSync(path, 'x'.repeat(300));

  assert.equal(rotateFileIfOversized(path, { maxBytes: 200, backups: 2 }), true);
  assert.equal(statSync(path).size, 0);
  assert.equal(readFileSync(`${path}.1`, 'utf8').length, 300, 'the retired content is kept, not dropped');

  assert.equal(rotateFileIfOversized(path, { maxBytes: 200, backups: 2 }), false);
  assert.equal(rotateFileIfOversized(join(tempDir('logs-absent'), 'nothing.log')), false);
});
