import assert from 'node:assert/strict';
import { mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { placeBlob, writeAtOffset } from '../src/blobs.js';
import { crc32Hex, hashFile } from '../src/hash.js';
import { resolveInside } from '../src/paths.js';
import { FileContentReader } from '../src/reader.js';
import { VirtualProviderRegistry } from '../src/virtual.js';

test('crc32 and sha256 match known vectors', async () => {
  assert.equal(crc32Hex(Buffer.from('123456789')), 'cbf43926');
  const dir = await mkdtemp(join(tmpdir(), 'ecs-hash-'));
  try {
    const file = join(dir, 'abc.txt');
    await writeFile(file, 'abc');
    const hashed = await hashFile(file);
    assert.equal(hashed.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(hashed.size, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('blob placement is idempotent when the metadata commit has not happened', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-blob-'));
  try {
    const source = join(dir, 'source.bin');
    await writeFile(source, Buffer.from('disc-image'));
    const first = await placeBlob(dir, source);
    const second = await placeBlob(dir, source);
    assert.equal(second.sha256, first.sha256);
    assert.equal(second.path, first.path);
    const partial = join(
      dir,
      'blobs',
      'sha256',
      first.sha256.slice(0, 2),
      `.${first.sha256}.partial`,
    );
    await writeFile(partial, Buffer.from('torn'));
    const reader = new FileContentReader(first.path, first.size);
    const chunks: Buffer[] = [];
    for await (const chunk of reader.openFull()) chunks.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(chunks).toString(), 'disc-image');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an interrupted ranged write truncates back to the committed offset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-stage-'));
  const file = join(dir, 'upload.bin');
  await writeFile(file, Buffer.alloc(0));
  const failing = new Readable({
    read() {
      this.push(Buffer.from('hello'));
      this.destroy(new Error('socket reset'));
    },
  });
  await assert.rejects(writeAtOffset(file, 0, failing, 100));
  const { size } = await import('node:fs/promises').then((fs) => fs.stat(file));
  assert.equal(size, 0);
  await rm(dir, { recursive: true, force: true });
});

test('reads the tail of a multi-gigabyte sparse file without scanning it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-sparse-'));
  const file = join(dir, 'sparse.bin');
  const handle = await open(file, 'w');
  const size = 2 * 1024 * 1024 * 1024;
  try {
    await handle.truncate(size);
    await handle.write(Buffer.from('TAIL'), 0, 4, size - 4);
  } finally {
    await handle.close();
  }
  const reader = new FileContentReader(file, size);
  const chunks: Buffer[] = [];
  for await (const chunk of reader.openRange(size - 4, size - 1)) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), 'TAIL');
  await rm(dir, { recursive: true, force: true });
});

test('symlink targets cannot escape the data root', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'ecs-outside-'));
  try {
    await symlink(outside, join(dir, 'escape'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('symlinks are not permitted on this host');
      return;
    }
    throw error;
  }
  await assert.rejects(resolveInside(dir, join('escape', 'secret')));
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('virtual content registry is empty until a format provider is registered', async () => {
  const registry = new VirtualProviderRegistry();
  assert.deepEqual(registry.formats(), []);
  assert.equal(await registry.inspect('unused.bin'), null);
});
