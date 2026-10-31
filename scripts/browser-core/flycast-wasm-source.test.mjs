import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  restoreZlibHeaderRename,
  snapshotPinnedSource,
  verifyPinnedSource,
} from './flycast-wasm-source.mjs';

function git(path, ...args) {
  const result = spawnSync('git', args, { cwd: path, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function repository(path) {
  mkdirSync(path);
  git(path, 'init', '--quiet');
  git(path, 'config', 'user.name', 'Generated source test');
  git(path, 'config', 'user.email', 'generated@example.invalid');
  writeFileSync(join(path, 'source.txt'), 'committed source\n');
  writeFileSync(join(path, '.gitignore'), 'build/\n');
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', 'generated source');
}
function commit(path) {
  git(path, 'add', '.');
  git(path, 'commit', '--quiet', '-m', 'generated gitlink');
  return git(path, 'rev-parse', 'HEAD');
}

test('committed recursive snapshots preserve caller tracked, untracked and ignored files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ecs-flycast-snapshot-'));
  try {
    const leaf = join(root, 'leaf'),
      middle = join(root, 'middle'),
      source = join(root, 'source');
    for (const path of [leaf, middle, source]) repository(path);
    git(
      middle,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      leaf,
      'nested leaf',
    );
    commit(middle);
    git(
      source,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      middle,
      'deps/middle',
    );
    git(
      source,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--quiet',
    );
    const pin = commit(source),
      callerLeaf = join(source, 'deps/middle/nested leaf');
    writeFileSync(join(source, 'source.txt'), 'caller work in progress\n');
    writeFileSync(join(source, 'notes.txt'), 'caller untracked\n');
    mkdirSync(join(source, 'build'));
    writeFileSync(join(source, 'build/keep.o'), 'caller ignored build\n');
    writeFileSync(join(callerLeaf, 'source.txt'), 'caller dependency edits\n');
    const destination = join(root, 'snapshot');
    snapshotPinnedSource(source, destination, pin);
    assert.equal(readFileSync(join(destination, 'source.txt'), 'utf8'), 'committed source\n');
    assert.equal(
      readFileSync(join(destination, 'deps/middle/nested leaf/source.txt'), 'utf8'),
      'committed source\n',
    );
    assert.equal(existsSync(join(destination, 'notes.txt')), false);
    assert.equal(existsSync(join(destination, 'build')), false);
    assert.equal(readFileSync(join(source, 'source.txt'), 'utf8'), 'caller work in progress\n');
    assert.equal(readFileSync(join(source, 'notes.txt'), 'utf8'), 'caller untracked\n');
    assert.equal(readFileSync(join(source, 'build/keep.o'), 'utf8'), 'caller ignored build\n');
    assert.equal(readFileSync(join(callerLeaf, 'source.txt'), 'utf8'), 'caller dependency edits\n');
    assert.equal(git(source, 'rev-parse', 'HEAD'), pin);
    verifyPinnedSource(destination, pin);
    const stageLeaf = join(destination, 'deps/middle/nested leaf');
    writeFileSync(join(stageLeaf, 'source.txt'), 'unexpected staged dependency edit\n');
    assert.throws(() => verifyPinnedSource(destination, pin, true), /tracked changes/);
    git(stageLeaf, 'config', 'user.name', 'Generated source test');
    git(stageLeaf, 'config', 'user.email', 'generated@example.invalid');
    commit(stageLeaf);
    assert.throws(
      () => verifyPinnedSource(destination, pin, true),
      /HEAD mismatch|tracked changes/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uninitialized submodule snapshots fetch the committed metadata URL and exact gitlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'ecs-flycast-uninitialized-'));
  try {
    const leaf = join(root, 'leaf'),
      source = join(root, 'source');
    repository(leaf);
    repository(source);
    const leafPin = git(leaf, 'rev-parse', 'HEAD');
    git(
      source,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '--quiet',
      leaf,
      'dependency',
    );
    const pin = commit(source);
    git(source, 'submodule', 'deinit', '--all', '--force');
    const destination = join(root, 'snapshot');
    snapshotPinnedSource(source, destination, pin);
    assert.equal(git(join(destination, 'dependency'), 'rev-parse', 'HEAD'), leafPin);
    verifyPinnedSource(destination, pin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('known zlib configure rename restores only exact committed bytes in staging', () => {
  const root = mkdtempSync(join(tmpdir(), 'ecs-flycast-zlib-'));
  try {
    const core = join(root, 'core'),
      child = join(core, 'core/deps/libchdr');
    mkdirSync(join(core, 'core/deps'), { recursive: true });
    repository(child);
    mkdirSync(join(child, 'deps/zlib-1.3.1'), { recursive: true });
    const header = join(child, 'deps/zlib-1.3.1/zconf.h');
    writeFileSync(header, '/* generated test header */\n');
    const pin = commit(child);
    renameSync(header, `${header}.included`);
    assert.throws(() => verifyPinnedSource(child, pin), /tracked changes/);
    restoreZlibHeaderRename(core);
    verifyPinnedSource(child, pin);
    assert.equal(readFileSync(header, 'utf8'), '/* generated test header */\n');
    rmSync(header);
    writeFileSync(`${header}.included`, 'modified dependency bytes\n');
    assert.throws(() => restoreZlibHeaderRename(core), /Unexpected zlib/);
    assert.equal(existsSync(header), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
