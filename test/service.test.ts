import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Paths } from '../src/core/paths.js';
import { instanceSuffix, launchdLabel, launchdPlist, systemdUnit, systemdUnitName } from '../src/daemon/service.js';
import { tempDir } from './helpers.js';

/**
 * The coexistence guarantee (report U4, K15): the service identifier is scoped
 * by a hash of the state root, so eyes-on and no-mistakes cannot address each
 * other's job. It fails by construction, not by courtesy - and that is exactly
 * the sort of claim that has to be asserted rather than believed.
 */
test('the service label is scoped by the state root', () => {
  const a = Paths.withRoot(tempDir('svc-a'));
  const b = Paths.withRoot(tempDir('svc-b'));
  assert.match(instanceSuffix(a), /^[0-9a-f]{8}$/);
  assert.notEqual(instanceSuffix(a), instanceSuffix(b));
  assert.equal(instanceSuffix(a), instanceSuffix(Paths.withRoot(a.root)));
});

test('the label can never collide with the no-mistakes one', () => {
  const label = launchdLabel(Paths.withRoot(tempDir('svc-prefix')));
  assert.match(label, /^com\.adxable\.eyes-on\.daemon\.[0-9a-f]{8}$/);
  assert.ok(!label.includes('no-mistakes'));
  // The live no-mistakes label on the reference machine, for contrast.
  assert.notEqual(label, 'com.kunchenguid.no-mistakes.daemon.733b4626');
});

test('the unit passes --root explicitly, because the service exports only HOME and PATH', () => {
  const paths = Paths.withRoot(tempDir('svc-root'));
  const plist = launchdPlist(paths, '/opt/eyes-on/main.js', '/usr/bin/node');
  assert.ok(plist.includes('<string>--root</string>'));
  assert.ok(plist.includes(`<string>${paths.canonicalRoot()}</string>`));
  assert.ok(plist.includes(launchdLabel(paths)));
  // The working directory is the state root: never a repository, never anyone
  // else's worktree (report K9, M23).
  assert.ok(plist.includes(`<key>WorkingDirectory</key>\n  <string>${paths.canonicalRoot()}</string>`));

  const unit = systemdUnit(paths, '/opt/eyes-on/main.js', '/usr/bin/node');
  assert.ok(unit.includes(`--root ${paths.canonicalRoot()}`));
  assert.ok(unit.includes(`WorkingDirectory=${paths.canonicalRoot()}`));
  assert.match(systemdUnitName(paths), /^eyes-on-daemon-[0-9a-f]{8}\.service$/);
});
