import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fceummSourcePlan } from './rebuild-fceumm-source.mjs';

test('published legacy source uses its actual retroarch directory and included patch', () => {
  const root = mkdtempSync(join(tmpdir(), 'ecs-fce-source-'));
  const manifest = { id: 'org.libretro.fceumm', player: { web: {} } };
  try {
    writeFileSync(
      join(root, 'README.md'),
      'Generated source record 4d4bfc0fbaacca30d433e5c11b0b2b5242141b66 ac0d00a7fc01166f84c7bac01d1084ebfd2b865e 3.1.46',
    );
    const plan = fceummSourcePlan(root, manifest);
    assert.equal(plan.frontend, join(root, 'retroarch'));
    assert.equal(plan.patch, join(root, 'retroarch-save-files.patch'));
    assert.equal(plan.sourceDateEpoch, '1793145600');
    assert.equal(plan.receipt.manifest, manifest);
    assert.ok(plan.receipt.frontendFlags.includes('LIBRETRO=fceumm'));
    assert.throws(() => fceummSourcePlan(root), /--package/);
    writeFileSync(join(root, 'README.md'), 'wrong source');
    assert.throws(() => fceummSourcePlan(root, manifest), /source release/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('receipt-based source retains its existing frontend layout and exact output pins', () => {
  const root = mkdtempSync(join(tmpdir(), 'ecs-fce-source-'));
  try {
    const receipt = {
      frontendPin: '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66',
      corePin: 'ac0d00a7fc01166f84c7bac01d1084ebfd2b865e',
      frontendFlags: ['LIBRETRO=fceumm'],
      manifest: { id: 'org.libretro.fceumm' },
    };
    writeFileSync(join(root, 'ECS-BUILD.json'), JSON.stringify(receipt));
    const plan = fceummSourcePlan(root);
    assert.equal(plan.frontend, join(root, 'frontend'));
    assert.equal(plan.patch, null);
    assert.deepEqual(plan.receipt, receipt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
