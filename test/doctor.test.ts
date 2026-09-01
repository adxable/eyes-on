import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { labelCollisionRows, scanLaunchAgents, type DeclaredAgent } from '../src/cli/doctor.js';
import { tempDir } from './helpers.js';

/** Reading a property list goes through macOS' own plutil, so does this. */
const darwinOnly = { skip: process.platform === 'darwin' ? false : 'property lists are read with macOS plutil' };

/**
 * `doctor` fails only on what genuinely breaks eyes-on. Its own label is scoped
 * by a hash of its state root, so a duplicate between two unrelated third-party
 * jobs cannot reach it - reporting that as a failure would make a healthy
 * stage-0 install exit 1.
 */
const OWN_LABEL = 'com.adxable.eyes-on.daemon.af804f2b';
const OWN_PLIST = '/Users/someone/Library/LaunchAgents/com.adxable.eyes-on.daemon.af804f2b.plist';

function agent(file: string, label: string): DeclaredAgent {
  return { file, label };
}

test('an unrelated duplicate label is reported but never fails doctor', () => {
  const rows = labelCollisionRows(
    [agent('/a/com.vendor.thing.plist', 'com.vendor.thing'), agent('/a/com.vendor.thing.copy.plist', 'com.vendor.thing')],
    OWN_LABEL,
    OWN_PLIST,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, 'warn');
  assert.match(rows[0]?.detail ?? '', /com\.vendor\.thing/);
});

test('a duplicate that names eyes-on or no-mistakes is fatal', () => {
  for (const label of [OWN_LABEL, 'com.kunchenguid.no-mistakes.daemon.733b4626']) {
    const rows = labelCollisionRows(
      [agent('/a/one.plist', label), agent('/a/two.plist', label)],
      OWN_LABEL,
      OWN_PLIST,
    );
    assert.equal(rows.length, 1, `${label} should produce exactly one row`);
    assert.equal(rows[0]?.status, 'missing', `${label} must be fatal`);
  }
});

test('a foreign file declaring the eyes-on label is fatal even without a duplicate', () => {
  const rows = labelCollisionRows([agent('/a/someone-elses.plist', OWN_LABEL)], OWN_LABEL, OWN_PLIST);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, 'missing');
  assert.match(rows[0]?.detail ?? '', /someone-elses\.plist/);
});

test('our own plist declaring our own label is not a collision', () => {
  assert.deepEqual(labelCollisionRows([agent(OWN_PLIST, OWN_LABEL)], OWN_LABEL, OWN_PLIST), []);
});

/**
 * A file doctor could not read is a check it could not make. A file it read
 * that simply declares no label is not: it names no job, so it can collide with
 * nothing, and a healthy machine must not carry a permanent warning for it.
 */
test('the scan separates a label-less plist from one it could not read', darwinOnly, () => {
  const dir = tempDir('doctor-agents');
  writeFileSync(
    join(dir, 'renamed.plist'),
    '<?xml version="1.0"?>\n<plist version="1.0"><dict><key>Label</key><string>com.example.declared</string><key>ProgramArguments</key><array/></dict></plist>\n',
  );
  writeFileSync(join(dir, 'no-label.plist'), '<plist version="1.0">\n<dict/>\n</plist>\n');
  writeFileSync(join(dir, 'broken.plist'), 'this is not a property list at all\n');
  writeFileSync(join(dir, 'notes.txt'), 'ignored, not a plist\n');

  const scan = scanLaunchAgents(dir);
  assert.deepEqual(
    scan.agents.map((entry) => entry.label),
    ['com.example.declared'],
    'the label comes from the file contents, not its name',
  );
  assert.deepEqual(
    scan.unreadable.map((entry) => entry.file),
    ['broken.plist'],
    'a plist that reads cleanly and declares no label is not unreadable',
  );
  assert.ok((scan.unreadable[0]?.reason ?? '').length > 0, 'an unreadable file must say why');
  assert.equal(scan.directoryError, null);
});

test('a missing LaunchAgents directory is empty, not an error', () => {
  const dir = join(tempDir('doctor-no-agents'), 'does-not-exist');
  assert.deepEqual(scanLaunchAgents(dir), { directory: dir, agents: [], unreadable: [], directoryError: null });
});
