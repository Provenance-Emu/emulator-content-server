import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { backupData } from '../src/lifecycle.js';

const cli = fileURLToPath(new URL('../src/main.js', import.meta.url));

test('locations are registered, chosen as the write target, and backed up only while online', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-cli-locations-')));
  const dataDir = join(base, 'content-data');
  const extra = join(base, 'extra');
  const destination = join(base, 'backup');
  try {
    await mkdir(extra);
    assert.equal(run(['init', '--data', dataDir]).status, 0);
    const added = run(['locations', 'add', '--data', dataDir, '--path', extra, '--label', 'Extra']);
    assert.equal(added.status, 0, added.stderr);
    const listed = run(['locations', 'list', '--data', dataDir]);
    assert.match(listed.stdout, /write primary/);
    assert.match(listed.stdout, new RegExp(`Extra {2}${escapeRegExp(extra)}`));
    const id = listed.stdout
      .trim()
      .split('\n')
      .find((line) => line.includes('Extra'))
      ?.split(/\s+/)[0];
    assert.ok(id);

    const inside = run([
      'locations',
      'add',
      '--data',
      dataDir,
      '--path',
      join(dataDir, 'blobs'),
      '--label',
      'Inside',
    ]);
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /data directory/);

    const chosen = run(['locations', 'use', '--data', dataDir, '--id', id]);
    assert.equal(chosen.status, 0, chosen.stderr);
    assert.match(run(['locations', 'list', '--data', dataDir]).stdout, new RegExp(`${id}.*write`));
    const held = run(['locations', 'remove', '--data', dataDir, '--id', id]);
    assert.equal(held.status, 1);
    assert.match(held.stderr, /new bytes are written/);

    assert.equal(run(['locations', 'use', '--data', dataDir, '--primary']).status, 0);
    await rm(extra, { recursive: true, force: true });
    const report = run(['doctor', '--data', dataDir]);
    assert.equal(report.status, 1);
    assert.match(report.stdout, /integrity ok/);
    assert.match(report.stdout, /offline location Extra/);
    const refused = run(['backup', '--data', dataDir, '--to', destination]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Extra/);
    assert.match(refused.stderr, /offline/);
    await assert.rejects(stat(destination));

    await mkdir(join(extra, 'blobs', 'sha256'), { recursive: true });
    await writeFile(join(extra, 'blobs', 'sha256', 'marker'), 'kept');
    await backupData(dataDir, destination);
    assert.equal(
      await readFile(join(destination, 'locations', id, 'blobs', 'sha256', 'marker'), 'utf8'),
      'kept',
    );
    const manifest = JSON.parse(await readFile(join(destination, 'locations.json'), 'utf8')) as {
      label: string;
    }[];
    assert.equal(manifest[0]?.label, 'Extra');
    await stat(join(destination, 'library.sqlite'));
    await stat(join(destination, 'blobs'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
