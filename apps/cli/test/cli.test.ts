import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/main.js', import.meta.url));

test('init prints a bootstrap token once and doctor accepts the data directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-cli-'));
  try {
    const first = run(['init', '--data', dir, '--name', 'Test Library']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Bootstrap token:/);
    const mode = (await stat(join(dir, 'bootstrap.token'))).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);
    const second = run(['init', '--data', dir]);
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /Bootstrap token:/);
    const report = run(['doctor', '--data', dir]);
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /integrity ok/);
    assert.match(report.stdout, /bootstrap pending/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('roots are saved, listed, and removed through the CLI', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-cli-roots-')));
  const dataDir = join(base, 'content-data');
  const collection = join(base, 'collection');
  const nested = join(collection, 'nes');
  try {
    await mkdir(nested, { recursive: true });
    assert.equal(run(['init', '--data', dataDir]).status, 0);

    const added = run([
      'roots',
      'add',
      '--data',
      dataDir,
      '--path',
      collection,
      '--label',
      'Shelf',
    ]);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /^saved \S+ /);

    const listed = run(['roots', 'list', '--data', dataDir]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`Shelf {2}${escapeRegExp(collection)}`));
    const id = listed.stdout.trim().split(/\s+/)[0];
    assert.ok(id);

    const overlapping = run([
      'roots',
      'add',
      '--data',
      dataDir,
      '--path',
      nested,
      '--label',
      'Nested',
    ]);
    assert.equal(overlapping.status, 1);
    assert.match(overlapping.stderr, /overlaps/);

    const insideData = run([
      'roots',
      'add',
      '--data',
      dataDir,
      '--path',
      join(dataDir, 'blobs'),
      '--label',
      'Data',
    ]);
    assert.equal(insideData.status, 1);
    assert.match(insideData.stderr, /outside the data directory/);

    const incomplete = run(['roots', 'add', '--data', dataDir, '--path', collection]);
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /--path and --label/);

    const removed = run(['roots', 'remove', '--data', dataDir, '--id', id]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(run(['roots', 'list', '--data', dataDir]).stdout.trim(), '');
    assert.equal(run(['roots', 'remove', '--data', dataDir, '--id', id]).status, 1);
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
