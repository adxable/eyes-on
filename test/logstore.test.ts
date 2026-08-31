import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { RotatingLog } from '../src/core/logstore.js';
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
