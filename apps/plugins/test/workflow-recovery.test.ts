import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { exportWorkflowHostState, restoreWorkflowHostState } from '../src/workflows/backup.js';
import { installBundledCleanup } from '../src/workflows/bundled.js';
import { lockWorkflowPackages } from '../src/workflows/package-lock.js';
import { activateWorkflowPackage, resolveWorkflowPackage } from '../src/workflows/packages.js';
import { openWorkflowState } from '../src/workflows/state.js';

test('coordinated host snapshot preserves pinned packages and blocks restored unfinished operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-host-backup-'));
  try {
    const source = join(directory, 'source');
    await mkdir(source, { mode: 0o700 });
    const installed = await installBundledCleanup(source);
    const state = await openWorkflowState(source);
    state.initializeRun('unfinished');
    state.close();
    await writeFile(join(source, 'credential'), 'generated-secret', { mode: 0o600 });
    const backup = join(directory, 'backup');
    await exportWorkflowHostState(source, backup);
    await assert.rejects(exportWorkflowHostState(source, backup));
    await assert.rejects(readFile(join(backup, 'credential')), /ENOENT/);
    const restored = join(directory, 'restored');
    await restoreWorkflowHostState(backup, restored);
    assert.equal(
      (await resolveWorkflowPackage(restored, installed.manifest.id)).digest,
      installed.digest,
    );
    const recovered = await openWorkflowState(restored);
    assert.deepEqual(recovered.recoveryRuns(), ['unfinished']);
    recovered.close();
    await writeFile(join(backup, 'workflow-host.sqlite'), 'generated-corruption');
    await assert.rejects(restoreWorkflowHostState(backup, join(directory, 'corrupt')), /backup/i);
    await assert.rejects(readFile(join(directory, 'corrupt/workflow-host.sqlite')), /ENOENT/);
    const interrupted = join(directory, 'interrupted');
    await mkdir(interrupted);
    await assert.rejects(restoreWorkflowHostState(interrupted, join(directory, 'missing')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('backups and package activation wait for the shared mutation lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-host-backup-race-'));
  let unlock: (() => void) | undefined;
  try {
    const source = join(directory, 'source');
    const installed = await installBundledCleanup(source);
    unlock = await lockWorkflowPackages(source);
    let backedUp = false,
      activated = false;
    const backup = exportWorkflowHostState(source, join(directory, 'backup')).then(() => {
      backedUp = true;
    });
    const activation = activateWorkflowPackage(
      source,
      installed.manifest.id,
      installed.digest,
    ).then(() => {
      activated = true;
    });
    await delay(75);
    assert.equal(backedUp, false);
    assert.equal(activated, false);
    unlock();
    unlock = undefined;
    await Promise.all([backup, activation]);
    const restored = join(directory, 'restored');
    await restoreWorkflowHostState(join(directory, 'backup'), restored);
    assert.equal(
      (await resolveWorkflowPackage(restored, installed.manifest.id)).digest,
      installed.digest,
    );
  } finally {
    unlock?.();
    await rm(directory, { recursive: true, force: true });
  }
});
