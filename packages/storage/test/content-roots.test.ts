import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DomainError } from '@ecs/domain';
import { ensureLayout, pathsOverlap, resolveContentRoot, resolveInside } from '../src/index.js';

function rejected(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

test('a content root is resolved to its real path and kept outside the data directory', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-roots-')));
  const dataDir = join(base, 'content-data');
  const collection = join(base, 'collection');
  try {
    await ensureLayout(dataDir);
    await mkdir(collection);
    const link = join(base, 'link-to-collection');
    await symlink(collection, link);

    assert.equal(await resolveContentRoot(dataDir, collection, []), collection);
    assert.equal(
      await resolveContentRoot(dataDir, link, []),
      collection,
      'a symlinked root records the directory it points at, so a later swap cannot redirect reads',
    );

    await assert.rejects(
      resolveContentRoot(dataDir, 'collection', []),
      rejected('invalid-root'),
      'a relative path is refused because a daemon has no meaningful working directory',
    );
    await assert.rejects(
      resolveContentRoot(dataDir, join(base, 'absent'), []),
      rejected('invalid-root'),
    );

    const file = join(base, 'notes.txt');
    await writeFile(file, 'not a directory');
    await assert.rejects(resolveContentRoot(dataDir, file, []), rejected('invalid-root'));

    await assert.rejects(resolveContentRoot(dataDir, dataDir, []), rejected('invalid-root'));
    await assert.rejects(
      resolveContentRoot(dataDir, join(dataDir, 'blobs'), []),
      rejected('invalid-root'),
    );
    await assert.rejects(
      resolveContentRoot(join(dataDir, 'blobs'), base, []),
      rejected('invalid-root'),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a root that overlaps a saved root is refused', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-roots-')));
  const dataDir = join(base, 'content-data');
  const games = join(base, 'games');
  const nested = join(games, 'nes');
  const sibling = join(base, 'saves');
  try {
    await ensureLayout(dataDir);
    await mkdir(nested, { recursive: true });
    await mkdir(sibling);

    await assert.rejects(resolveContentRoot(dataDir, games, [games]), rejected('conflict'));
    await assert.rejects(resolveContentRoot(dataDir, nested, [games]), rejected('conflict'));
    await assert.rejects(resolveContentRoot(dataDir, games, [nested]), rejected('conflict'));
    assert.equal(await resolveContentRoot(dataDir, sibling, [games]), sibling);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('overlap compares whole path segments rather than string prefixes', () => {
  assert.equal(pathsOverlap('/games', '/games'), true);
  assert.equal(pathsOverlap('/games', '/games/nes'), true);
  assert.equal(pathsOverlap('/games/nes', '/games'), true);
  assert.equal(pathsOverlap('/games', '/games-backup'), false);
  assert.equal(pathsOverlap('/games', '/saves'), false);
  assert.equal(pathsOverlap('C:\\games', 'C:\\games\\nes'), true);
  assert.equal(pathsOverlap('C:\\games', 'C:\\games-backup'), false);
  assert.equal(pathsOverlap('C:/games', 'C:\\games\\nes'), true);
  assert.equal(pathsOverlap('C:\\games', 'D:\\games'), false);
});

test('reading inside a root refuses a symlink that escapes it', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-roots-')));
  const root = join(base, 'games');
  const outside = join(base, 'outside');
  try {
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, 'inside.bin'), Buffer.alloc(4));
    await writeFile(join(outside, 'secret.bin'), Buffer.alloc(4));
    await symlink(join(outside, 'secret.bin'), join(root, 'escape.bin'));

    assert.equal(await resolveInside(root, 'inside.bin'), join(root, 'inside.bin'));
    await assert.rejects(resolveInside(root, 'escape.bin'), /escapes/);
    await assert.rejects(resolveInside(root, '../outside/secret.bin'), /escapes/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
