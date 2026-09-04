import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateRoot, tempDir } from './helpers.js';

/**
 * Deliverable 1 is a package whose `eyes-on` binary runs. What decides that is
 * not the repository - where a build has usually happened already - but the
 * tarball `npm publish` produces from a checkout that has never been built:
 * `dist/` is generated and ignored, so unless packing builds it, the published
 * `bin/eyes-on.js` cannot resolve its entry module and the binary fails on the
 * first invocation with ERR_MODULE_NOT_FOUND.
 *
 * So the artefact is packed from a copy that carries only the checked-in
 * sources, and the assertion is the binary answering out of the extracted
 * tarball. Nothing here greps the packaging configuration: what is asserted is
 * that the published command runs.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Everything git tracks that packing needs, and deliberately no `dist`. */
const CHECKED_IN = ['package.json', 'tsconfig.json', 'bin', 'src', 'test', 'skills', 'README.md'];

function packedBinary(): { dir: string; bin: string } {
  const work = tempDir('pack-source');
  const checkout = join(work, 'checkout');
  mkdirSync(checkout, { recursive: true });
  for (const entry of CHECKED_IN) {
    cpSync(join(repoRoot, entry), join(checkout, entry), { recursive: true });
  }
  // The toolchain is a devDependency and packing runs the build, so the copy
  // borrows the installed one rather than reinstalling it.
  symlinkSync(join(repoRoot, 'node_modules'), join(checkout, 'node_modules'), 'dir');

  const destination = join(work, 'tarball');
  mkdirSync(destination, { recursive: true });
  const packed = spawnSync('npm', ['pack', '--pack-destination', destination], {
    cwd: checkout,
    encoding: 'utf8',
    timeout: 300_000,
  });
  assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr}`);

  const tarball = readdirSync(destination).find((name) => name.endsWith('.tgz'));
  assert.ok(tarball, 'npm pack produced no tarball');

  const extracted = join(work, 'installed');
  mkdirSync(extracted, { recursive: true });
  const untar = spawnSync('tar', ['-xzf', join(destination, tarball), '-C', extracted], { encoding: 'utf8' });
  assert.equal(untar.status, 0, `extracting the tarball failed: ${untar.stderr}`);

  return { dir: join(extracted, 'package'), bin: join(extracted, 'package', 'bin', 'eyes-on.js') };
}

test('the packed binary runs from a checkout that was never built', () => {
  const { dir, bin } = packedBinary();
  const version = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;

  const ran = spawnSync(process.execPath, [bin, '--version'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, EYES_HOME: stateRoot() },
    timeout: 60_000,
  });

  assert.equal(ran.status, 0, `the packed binary failed: ${ran.stderr}`);
  assert.match(ran.stdout, new RegExp(`eyes-on ${version.replace(/\./g, '\\.')}`));

  // And it is the real dispatcher behind it, not just a shim that loaded: the
  // help screen is generated from the command registry the binary shipped with.
  const help = spawnSync(process.execPath, [bin, 'help'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, EYES_HOME: stateRoot() },
    timeout: 60_000,
  });
  assert.equal(help.status, 0, `the packed binary could not print help: ${help.stderr}`);
  assert.match(help.stdout, /eyes-on init/);
});

test('git reads every tracked source file as text, so a diff of it can still be shown', () => {
  // A single literal NUL byte makes a file binary to git: `git diff --stat`
  // reports `Bin 0 -> 8287 bytes` and no diff of it is ever rendered again -
  // not by git, not by GitHub, not by a review tool, and not by eyes-on's own
  // hunk parser, which yields no fragment for a binary file. In a product whose
  // whole job is deciding what a human must read, a source file nobody can read
  // a change to is a defect, so git's own classification is the check.
  //
  // The working-tree column is what is asserted, because that is the file on
  // disk; the index column would describe the last commit instead.
  const listed = spawnSync('git', ['ls-files', '--eol', '--', 'src', 'test'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);

  const rows = listed.stdout.split('\n').filter((line) => line.length > 0);
  assert.ok(rows.length > 50, 'the listing covers the sources rather than being empty');

  const binary = rows
    .filter((row) => /\bw\/-text\b/.test(row))
    .map((row) => row.slice(row.indexOf('\t') + 1));
  assert.deepEqual(binary, [], 'git reads these tracked source files as binary rather than as text');
});
