import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Paths } from '../src/core/paths.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  inspectInstalledUnit,
  instanceSuffix,
  launchdDefinition,
  launchdLabel,
  launchdPlist,
  parseLaunchdPlist,
  parseSystemdUnit,
  plistLabel,
  readPlist,
  sameServiceDefinition,
  systemdDefinition,
  systemdUnit,
  systemdUnitName,
} from '../src/daemon/service.js';
import { tempDir } from './helpers.js';

/** Reading a property list goes through macOS' own plutil, so does this. */
const darwinOnly = { skip: process.platform === 'darwin' ? false : 'property lists are read with macOS plutil' };

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

test('the unit passes --root explicitly, because the service exports only HOME and PATH', darwinOnly, () => {
  const paths = Paths.withRoot(tempDir('svc-root'));
  const plist = parseLaunchdPlist(launchdPlist(paths, '/opt/eyes-on/main.js', '/usr/bin/node'));
  assert.ok(plist, 'the generated plist must be readable as a property list');
  assert.equal(plist.label, launchdLabel(paths));
  // argv in order, so `--root` is a flag with the state root as its value and
  // not a stray token that happens to appear somewhere in the file.
  assert.deepEqual(plist.argv, [
    '/usr/bin/node',
    '/opt/eyes-on/main.js',
    'daemon',
    'run',
    '--root',
    paths.canonicalRoot(),
  ]);
  // The working directory is the state root: never a repository, never anyone
  // else's worktree (report K9, M23).
  assert.equal(plist.workingDirectory, paths.canonicalRoot());
  // Restart on failure only: a daemon that exits 0 because another already
  // holds the lock must not be restarted in a loop.
  assert.equal(plist.restart, 'on-failure');

  const unitName = systemdUnitName(paths);
  const unit = parseSystemdUnit(systemdUnit(paths, '/opt/eyes-on/main.js', '/usr/bin/node'), unitName);
  assert.ok(unit, 'the generated systemd unit must be readable');
  assert.deepEqual(unit.argv, plist.argv);
  assert.equal(unit.workingDirectory, paths.canonicalRoot());
  assert.equal(unit.restart, 'on-failure');
  assert.match(unitName, /^eyes-on-daemon-[0-9a-f]{8}\.service$/);
});

/**
 * The idempotency property from the stage 0 acceptance conditions, at the level
 * it is actually decided: a repeat `init` from a shell with a different PATH
 * must not count as a changed unit, because reloading the job would bounce a
 * healthy daemon.
 */
test('a unit that differs only in the installing shell environment is not a change', darwinOnly, () => {
  const paths = Paths.withRoot(tempDir('svc-idempotent'));
  const previousPath = process.env.PATH;
  let fromOneShell: string;
  let fromAnotherShell: string;
  try {
    process.env.PATH = '/usr/bin:/bin';
    fromOneShell = launchdPlist(paths, '/opt/eyes-on/main.js', '/usr/bin/node');
    process.env.PATH = '/Users/someone/.nvm/versions/node/v22.21.1/bin:/usr/bin:/bin';
    fromAnotherShell = launchdPlist(paths, '/opt/eyes-on/main.js', '/usr/bin/node');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  assert.notEqual(fromOneShell, fromAnotherShell, 'the two plists must differ in bytes for this test to mean anything');
  const one = parseLaunchdPlist(fromOneShell);
  const another = parseLaunchdPlist(fromAnotherShell);
  assert.ok(one);
  assert.ok(another);
  assert.ok(sameServiceDefinition(one, another), 'a different PATH must not read as a changed service');

  // A genuinely different definition still is one.
  const moved = parseLaunchdPlist(launchdPlist(paths, '/opt/eyes-on/other.js', '/usr/bin/node'));
  assert.ok(moved);
  assert.ok(!sameServiceDefinition(moved, one), 'a changed executable must read as a changed service');
});

test('a LaunchAgent label is read from what the plist declares, not from its filename', darwinOnly, () => {
  const paths = Paths.withRoot(tempDir('svc-label'));
  const own = readPlist(launchdPlist(paths, '/opt/eyes-on/main.js', '/usr/bin/node'));
  assert.ok(own.ok);
  assert.equal(plistLabel(own.value), launchdLabel(paths));

  // The label carries no relation to the file it is stored in, which is exactly
  // why doctor cannot derive collisions from filenames.
  const foreign = readPlist(
    '<?xml version="1.0"?>\n<plist version="1.0"><dict><key>Label</key><string>com.example.job</string></dict></plist>',
  );
  assert.ok(foreign.ok);
  assert.equal(plistLabel(foreign.value), 'com.example.job');
});

/**
 * The shapes ~/Library/LaunchAgents actually contains. A reader that stops at
 * any of them makes the impostor `doctor` exists to catch invisible, so each is
 * asserted rather than assumed.
 */
test('the plist reader copes with the shapes real LaunchAgents use', darwinOnly, () => {
  const withSelfClosingLeaf = readPlist(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      '<dict>',
      '  <key>ServiceDescription</key>',
      '  <string/>',
      '  <key>Label</key>',
      '  <string>com.adxable.eyes-on.daemon.deadbeef</string>',
      '  <key>ProgramArguments</key>',
      '  <array/>',
      '  <key>EnvironmentVariables</key>',
      '  <dict/>',
      '  <key>RunAtLoad</key>',
      '  <true/>',
      '</dict>',
      '</plist>',
    ].join('\n'),
  );
  assert.ok(withSelfClosingLeaf.ok, 'a self-closing leaf must not hide the keys after it');
  assert.equal(plistLabel(withSelfClosingLeaf.value), 'com.adxable.eyes-on.daemon.deadbeef');
  assert.equal(withSelfClosingLeaf.value.ServiceDescription, '');
  assert.deepEqual(withSelfClosingLeaf.value.ProgramArguments, []);
  assert.deepEqual(withSelfClosingLeaf.value.EnvironmentVariables, {});
  assert.equal(withSelfClosingLeaf.value.RunAtLoad, true);

  // An empty job: read successfully, declares no label, collides with nothing.
  const empty = readPlist('<plist version="1.0">\n<dict/>\n</plist>\n');
  assert.ok(empty.ok);
  assert.equal(plistLabel(empty.value), null);

  const broken = readPlist('this is not a property list at all\n');
  assert.equal(broken.ok, false, 'a file that is not a property list must be reported, not guessed at');
});

/**
 * systemd splits ExecStart on whitespace, so a state root containing a space
 * has to survive the round trip - otherwise every repeat init reads the unit as
 * changed and restarts a healthy daemon.
 */
test('a state root containing a space round-trips through the systemd unit', () => {
  const paths = Paths.withRoot(join(tempDir('svc space'), 'a b', 'state root'));
  const executable = '/opt/eyes on/main.js';
  const desired = systemdDefinition(paths, executable, '/usr/bin/node');
  const parsed = parseSystemdUnit(systemdUnit(paths, executable, '/usr/bin/node'), systemdUnitName(paths));
  assert.ok(parsed);
  assert.deepEqual(parsed.argv, ['/usr/bin/node', executable, 'daemon', 'run', '--root', paths.canonicalRoot()]);
  assert.equal(parsed.workingDirectory, paths.canonicalRoot());
  assert.ok(sameServiceDefinition(parsed, desired), 'a path with a space must not read as a changed service');
});

/**
 * Writing the file and restarting the job are separate decisions. A template
 * change outside the compared definition must reach an existing install, while
 * still not counting as a reason to reload.
 */
test('a template change outside the definition is written but does not mean a reload', darwinOnly, () => {
  const paths = Paths.withRoot(tempDir('svc-refresh'));
  const desired = launchdDefinition(paths, '/opt/eyes-on/main.js', '/usr/bin/node');
  const current = launchdPlist(paths, '/opt/eyes-on/main.js', '/usr/bin/node');
  const stale = current.replace(
    '<key>RunAtLoad</key>',
    '<key>ProcessType</key>\n  <string>Background</string>\n  <key>RunAtLoad</key>',
  );
  const unitPath = join(tempDir('svc-refresh-unit'), 'agent.plist');
  writeFileSync(unitPath, stale);

  const existing = inspectInstalledUnit(unitPath, current, desired, (installed) => parseLaunchdPlist(installed));
  assert.equal(existing.sameBytes, false, 'the file on disk differs, so it must be rewritten');
  assert.equal(existing.sameMeaning, true, 'the declaration is unchanged, so the job must not be reloaded');
});
