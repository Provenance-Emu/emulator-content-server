import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { run } from '../src/host.js';
import {
  activateWorkflowPackage,
  disableWorkflowPackage,
  installWorkflowPackage,
  listWorkflowPackages,
  resolveWorkflowPackage,
  snapshotWorkflowDirectory,
} from '../src/workflows/packages.js';

function bundle(version: string) {
  const content = Buffer.from('throw new Error("install must never execute code");');
  const header = Buffer.from(
    JSON.stringify({
      manifest: {
        id: 'org.example.translator',
        name: 'Generated translator',
        version,
        engine: 'ecs.plugin/2',
        hostApi: '^1.0.0',
        kind: 'translator',
        entry: 'translator.mjs',
        provides: [{ capability: 'text.generate', major: 1 }],
      },
      files: [
        {
          name: 'translator.mjs',
          size: content.length,
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      ],
    }),
  );
  const size = Buffer.alloc(4);
  size.writeUInt32BE(header.length);
  return Buffer.concat([size, header, content]);
}

test('installation never activates code, and updates preserve pinned packages', async () => {
  const state = await mkdtemp(join(tmpdir(), 'ecs-workflow-install-'));
  try {
    const a = await installWorkflowPackage(state, bundle('1.0.0'));
    await assert.rejects(resolveWorkflowPackage(state, a.manifest.id));
    await activateWorkflowPackage(state, a.manifest.id, a.digest);
    const b = await installWorkflowPackage(state, bundle('1.1.0'));
    await assert.rejects(resolveWorkflowPackage(state, b.manifest.id, b.digest));
    await activateWorkflowPackage(state, b.manifest.id, b.digest);
    assert.equal((await resolveWorkflowPackage(state, a.manifest.id)).digest, b.digest);
    assert.equal(
      (await resolveWorkflowPackage(state, a.manifest.id, a.digest)).manifest.version,
      '1.0.0',
    );
    await access(join(a.directory, 'translator.mjs'));
    assert.equal((await listWorkflowPackages(state)).length, 2);
    const again = await installWorkflowPackage(state, bundle('1.0.0'));
    assert.equal(again.digest, a.digest);
    await disableWorkflowPackage(state, a.manifest.id);
    await assert.rejects(resolveWorkflowPackage(state, a.manifest.id));
    await assert.rejects(resolveWorkflowPackage(state, a.manifest.id, a.digest));
    await activateWorkflowPackage(state, a.manifest.id, a.digest);
    assert.equal((await resolveWorkflowPackage(state, a.manifest.id)).digest, a.digest);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('package lookup cannot escape its state directory', async () => {
  const state = await mkdtemp(join(tmpdir(), 'ecs-workflow-lookup-'));
  try {
    await assert.rejects(resolveWorkflowPackage(state, '../outside', '0'.repeat(64)));
    await assert.rejects(activateWorkflowPackage(state, 'org.example.translator', '../outside'));
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('concurrent activations preserve authorization for both pinned versions', async () => {
  const state = await mkdtemp(join(tmpdir(), 'ecs-workflow-activation-race-'));
  try {
    const a = await installWorkflowPackage(state, bundle('1.0.0'));
    const b = await installWorkflowPackage(state, bundle('1.1.0'));
    await Promise.all([
      activateWorkflowPackage(state, a.manifest.id, a.digest),
      activateWorkflowPackage(state, b.manifest.id, b.digest),
    ]);
    assert.equal((await resolveWorkflowPackage(state, a.manifest.id, a.digest)).digest, a.digest);
    assert.equal((await resolveWorkflowPackage(state, b.manifest.id, b.digest)).digest, b.digest);
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('workflow CLI installs and activates without a server token or executing its entry', async () => {
  const state = await mkdtemp(join(tmpdir(), 'ecs-workflow-cli-'));
  try {
    const path = join(state, 'bundle.ecsw');
    await writeFile(path, bundle('1.0.0'));
    const lines: string[] = [];
    const io = {
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    };
    assert.equal(
      await run(
        ['node', 'ecs-plugins', 'workflows', 'install', '--state', state, '--bundle', path],
        {},
        io,
      ),
      0,
      lines.join('\n'),
    );
    const installed = (await listWorkflowPackages(state))[0];
    assert.ok(installed);
    assert.equal(
      await run(
        [
          'node',
          'ecs-plugins',
          'workflows',
          'activate',
          '--state',
          state,
          '--id',
          installed.manifest.id,
          '--digest',
          installed.digest,
        ],
        {},
        io,
      ),
      0,
    );
    assert.equal(
      await run(['node', 'ecs-plugins', 'workflows', 'list', '--state', state], {}, io),
      0,
    );
    assert.equal(
      await run(
        [
          'node',
          'ecs-plugins',
          'workflows',
          'disable',
          '--state',
          state,
          '--id',
          installed.manifest.id,
        ],
        {},
        io,
      ),
      0,
    );
    await assert.rejects(resolveWorkflowPackage(state, installed.manifest.id));
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test('development directories are snapshotted and cannot bundle symlinks', async () => {
  const source = await mkdtemp(join(tmpdir(), 'ecs-workflow-dev-'));
  const state = await mkdtemp(join(tmpdir(), 'ecs-workflow-dev-state-'));
  try {
    await writeFile(
      join(source, 'plugin.json'),
      JSON.stringify({
        id: 'org.example.development',
        name: 'Development',
        version: '1.0.0',
        engine: 'ecs.plugin/2',
        hostApi: '^1.0.0',
        kind: 'translator',
        entry: 'translator.mjs',
        provides: [{ capability: 'text.generate', major: 1 }],
      }),
    );
    await writeFile(join(source, 'translator.mjs'), 'throw new Error("do not execute");');
    const snapshot = await snapshotWorkflowDirectory(source);
    const installed = await installWorkflowPackage(state, snapshot);
    await writeFile(join(source, 'translator.mjs'), 'changed after snapshot');
    assert.equal(
      await readFile(join(installed.directory, 'translator.mjs'), 'utf8'),
      'throw new Error("do not execute");',
    );
    await symlink(join(source, 'translator.mjs'), join(source, 'linked.mjs'));
    await assert.rejects(snapshotWorkflowDirectory(source));
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
