import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyOrganization, portableSegment, previewOrganization } from '../src/organization.js';

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-organize-')));
  const from = join(base, 'from');
  const to = join(base, 'to');
  await mkdir(from);
  await mkdir(to);
  await writeFile(join(from, 'generated.nes'), 'generated ROM bytes');
  return { base, from, to, dispose: () => rm(base, { recursive: true, force: true }) };
}

test('preview is read only; exclusive copy preserves bytes and supports compensation', async () => {
  const f = await fixture();
  try {
    const plan = await previewOrganization(
      f.from,
      'generated.nes',
      f.to,
      'NES/Title/generated.nes',
      'copy',
    );
    await assert.rejects(lstat(join(f.to, 'NES')), { code: 'ENOENT' });
    const operation = await applyOrganization(plan);
    assert.equal(await readFile(join(f.from, 'generated.nes'), 'utf8'), 'generated ROM bytes');
    assert.equal(
      await readFile(join(f.to, plan.targetRelativePath), 'utf8'),
      'generated ROM bytes',
    );
    await operation.rollback();
    await assert.rejects(lstat(join(f.to, plan.targetRelativePath)), { code: 'ENOENT' });
  } finally {
    await f.dispose();
  }
});

test('move preparation retains original until catalog commit and can roll back', async () => {
  const f = await fixture();
  try {
    const plan = await previewOrganization(
      f.from,
      'generated.nes',
      f.to,
      'NES/Title/generated.nes',
      'move',
    );
    const operation = await applyOrganization(plan);
    assert.equal(await readFile(join(f.from, 'generated.nes'), 'utf8'), 'generated ROM bytes');
    assert.equal(
      await readFile(join(f.to, plan.targetRelativePath), 'utf8'),
      'generated ROM bytes',
    );
    await operation.rollback();
    assert.equal(await readFile(join(f.from, 'generated.nes'), 'utf8'), 'generated ROM bytes');
  } finally {
    await f.dispose();
  }
});

test('stale files, collisions, and symlink parents are rejected without overwriting', async () => {
  const f = await fixture();
  try {
    const plan = await previewOrganization(
      f.from,
      'generated.nes',
      f.to,
      'NES/Title/generated.nes',
      'move',
    );
    await writeFile(join(f.from, 'generated.nes'), 'changed');
    await assert.rejects(applyOrganization(plan), /changed/i);
    await mkdir(join(f.to, 'NES'));
    await writeFile(join(f.to, 'NES', 'collision.nes'), 'keep');
    await assert.rejects(
      previewOrganization(f.from, 'generated.nes', f.to, 'NES/collision.nes', 'copy'),
      /exists/i,
    );
    await symlink(f.from, join(f.to, 'linked'));
    await assert.rejects(
      previewOrganization(f.from, 'generated.nes', f.to, 'linked/new.nes', 'copy'),
      /symbolic/i,
    );
    assert.equal(await readFile(join(f.to, 'NES', 'collision.nes'), 'utf8'), 'keep');
  } finally {
    await f.dispose();
  }
});

test('portable path segments strip traversal, reserved names and separators', () => {
  assert.equal(portableSegment('../Title: x/y\\z'), '_Title_ x_y_z');
  assert.equal(portableSegment('CON'), '_CON');
  assert.equal(portableSegment('...'), 'Unknown');
});

test('move finalize removes original only after successful preparation', async () => {
  const f = await fixture();
  try {
    const plan = await previewOrganization(
      f.from,
      'generated.nes',
      f.to,
      'NES/Title/generated.nes',
      'move',
    );
    const operation = await applyOrganization(plan);
    assert.equal(await readFile(join(f.from, 'generated.nes'), 'utf8'), 'generated ROM bytes');
    await operation.finalize();
    await assert.rejects(lstat(join(f.from, 'generated.nes')), { code: 'ENOENT' });
    assert.equal(
      await readFile(join(f.to, plan.targetRelativePath), 'utf8'),
      'generated ROM bytes',
    );
  } finally {
    await f.dispose();
  }
});

test('finalize preserves an unrelated replacement of the original pathname', async () => {
  const f = await fixture();
  try {
    const plan = await previewOrganization(
      f.from,
      'generated.nes',
      f.to,
      'NES/Title/generated.nes',
      'move',
    );
    const operation = await applyOrganization(plan);
    await rm(join(f.from, 'generated.nes'));
    await writeFile(join(f.from, 'generated.nes'), 'unrelated replacement bytes');
    await assert.rejects(operation.finalize(), /changed/);
    assert.equal(
      await readFile(join(f.from, 'generated.nes'), 'utf8'),
      'unrelated replacement bytes',
    );
    assert.equal(
      await readFile(join(f.to, plan.targetRelativePath), 'utf8'),
      'generated ROM bytes',
    );
  } finally {
    await f.dispose();
  }
});
