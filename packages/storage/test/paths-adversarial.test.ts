import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveInside } from '../src/paths.js';

test('path containment rejects sibling-prefix escapes and allows safe missing descendants', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-containment-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'games');
  const sibling = join(base, 'games-backup');
  await mkdir(root);
  await mkdir(sibling);
  await writeFile(join(sibling, 'secret.bin'), 'outside sentinel');
  for (const target of [
    '../games-backup/secret.bin',
    '../games-backup/missing/file.bin',
    sibling,
  ]) {
    await assert.rejects(resolveInside(root, target), /Path escapes the data root/);
  }
  assert.equal(
    await resolveInside(root, 'saves/missing/file.bin'),
    join(root, 'saves/missing/file.bin'),
  );
  assert.equal(await readFile(join(sibling, 'secret.bin'), 'utf8'), 'outside sentinel');
});

test('directory links cannot redirect existing or missing descendants outside the root', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-symlink-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'games');
  const outside = join(base, 'outside');
  const inside = join(root, 'saves');
  await mkdir(inside, { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'secret.bin'), 'outside sentinel');
  await writeFile(join(inside, 'safe.bin'), 'inside sentinel');
  try {
    await symlink(outside, join(root, 'escape'), 'junction');
    await symlink(inside, join(root, 'safe-link'), 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.skip('This host does not permit directory links');
    return;
  }
  for (const target of ['escape/secret.bin', 'escape/missing/file.bin']) {
    await assert.rejects(resolveInside(root, target), /Path escapes the data root/);
  }
  assert.equal(await resolveInside(root, 'safe-link/safe.bin'), join(inside, 'safe.bin'));
  assert.equal(
    await resolveInside(root, 'safe-link/missing/file.bin'),
    join(inside, 'missing/file.bin'),
  );
  assert.equal(await readFile(join(outside, 'secret.bin'), 'utf8'), 'outside sentinel');
});
