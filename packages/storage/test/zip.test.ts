import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import type { MaterializeQuota } from '@ecs/domain';
import { placeBlob } from '../src/blobs.js';
import { crc32 } from '../src/hash.js';
import { ensureLayout } from '../src/layout.js';
import { FileContentReader } from '../src/reader.js';
import { VirtualProviderRegistry } from '../src/virtual.js';
import { listVirtualEntries, openVirtualEntry } from '../src/virtual-cache.js';
import { ZipProvider } from '../src/zip.js';

const QUOTA: MaterializeQuota = {
  maxExpandedBytes: 1024 * 1024,
  maxCompressionRatio: 20,
  maxEntries: 8,
  maxNesting: 2,
  timeoutMs: 5_000,
};

interface Member {
  name: string;
  body: Buffer;
  compress?: boolean;
  declaredSize?: number;
  declaredCrc?: number;
}

function hexCrc(body: Buffer): string {
  return ((crc32(body) ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

function buildZip(members: Member[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const payload = member.compress ? deflateRawSync(member.body) : member.body;
    const method = member.compress ? 8 : 0;
    const crc = member.declaredCrc ?? (crc32(member.body) ^ 0xffffffff) >>> 0;
    const declaredSize = member.declaredSize ?? member.body.length;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, payload);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

interface Staged {
  root: string;
  sha256: string;
  path: string;
  registry: VirtualProviderRegistry;
}

async function stageArchive(members: Member[], quota = QUOTA): Promise<Staged> {
  const root = await mkdtemp(join(tmpdir(), 'ecs-zip-'));
  await ensureLayout(root);
  const source = join(root, 'archive.zip');
  await writeFile(source, buildZip(members));
  const placed = await placeBlob(root, source);
  return {
    root,
    sha256: placed.sha256,
    path: placed.path,
    registry: new VirtualProviderRegistry([new ZipProvider()], quota),
  };
}

async function readRange(path: string, start: number, endInclusive: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = new FileContentReader(path, endInclusive + 1);
  for await (const chunk of reader.openRange(start, endInclusive)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function cachedFiles(root: string): Promise<string[]> {
  const entries = await readdir(join(root, 'virtual-cache'), {
    recursive: true,
    withFileTypes: true,
  });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

test('zip inspection lists files, skips directories, and reports each CRC', async () => {
  const disc = randomBytes(4096);
  const staged = await stageArchive([
    { name: 'rom/', body: Buffer.alloc(0) },
    { name: 'rom/disc.bin', body: disc },
    { name: 'readme.txt', body: Buffer.from('a'.repeat(2048)), compress: true },
  ]);
  try {
    const inspected = await staged.registry.inspect(staged.path);
    assert.ok(inspected);
    assert.equal(inspected.format, 'zip');
    assert.deepEqual(
      inspected.entries.map((entry) => [entry.entryId, entry.path, entry.method]),
      [
        ['1', 'rom/disc.bin', 'store'],
        ['2', 'readme.txt', 'deflate'],
      ],
    );
    assert.equal(inspected.entries[0]?.uncompressedSize, 4096);
    assert.equal(inspected.entries[0]?.crc, hexCrc(disc));
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('a stored entry is ranged straight out of the container with no cache copy', async () => {
  const body = randomBytes(4096);
  const staged = await stageArchive([{ name: 'disc.bin', body }]);
  try {
    const entry = await openVirtualEntry(staged.root, staged.sha256, staged.registry, '0');
    assert.ok(entry);
    assert.equal(entry.path, staged.path);
    assert.equal(entry.size, body.length);
    const middle = await readRange(entry.path, entry.offset + 1000, entry.offset + 1099);
    assert.deepEqual(middle, body.subarray(1000, 1100));
    assert.deepEqual(await cachedFiles(staged.root), []);
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('a deflated entry expands once and later ranges read the cache blob', async () => {
  const body = Buffer.concat([randomBytes(2048), Buffer.alloc(2048, 7)]);
  const staged = await stageArchive([{ name: 'save.srm', body, compress: true }]);
  try {
    const first = await openVirtualEntry(staged.root, staged.sha256, staged.registry, '0');
    assert.ok(first);
    assert.equal(first.offset, 0);
    assert.notEqual(first.path, staged.path);
    assert.equal(first.size, body.length);
    assert.equal((await cachedFiles(staged.root)).length, 1);

    const second = await openVirtualEntry(staged.root, staged.sha256, staged.registry, '0');
    assert.equal(second?.path, first.path);
    assert.equal((await cachedFiles(staged.root)).length, 1);

    const middle = await readRange(first.path, 2000, 2099);
    assert.deepEqual(middle, body.subarray(2000, 2100));
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('a zip of stored zips lists every inner rom and its crc without expanding', async () => {
  const sonic = randomBytes(2048);
  const echo = randomBytes(1024);
  const staged = await stageArchive([
    { name: 'Sonic.zip', body: buildZip([{ name: 'Sonic.md', body: sonic, compress: true }]) },
    { name: 'Echo.zip', body: buildZip([{ name: 'Echo.md', body: echo }]) },
  ]);
  try {
    const inspected = await staged.registry.inspect(staged.path);
    assert.ok(inspected);
    assert.deepEqual(
      inspected.entries.map((entry) => [entry.entryId, entry.path, entry.crc]),
      [
        ['0.0', 'Sonic.zip/Sonic.md', hexCrc(sonic)],
        ['1.0', 'Echo.zip/Echo.md', hexCrc(echo)],
      ],
    );
    assert.deepEqual(await cachedFiles(staged.root), []);
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('a stored rom inside a stored zip is served from the original blob', async () => {
  const rom = randomBytes(2048);
  const staged = await stageArchive([
    { name: 'Echo.zip', body: buildZip([{ name: 'Echo.md', body: rom }]) },
  ]);
  try {
    const entry = await openVirtualEntry(staged.root, staged.sha256, staged.registry, '0.0');
    assert.ok(entry);
    assert.equal(entry.path, staged.path);
    assert.equal(entry.logicalPath, 'Echo.zip/Echo.md');
    const middle = await readRange(entry.path, entry.offset + 100, entry.offset + 199);
    assert.deepEqual(middle, rom.subarray(100, 200));
    assert.deepEqual(await cachedFiles(staged.root), []);
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('a deflated rom inside a stored zip expands once and ranges correctly', async () => {
  const rom = Buffer.concat([randomBytes(1024), Buffer.alloc(1024, 9)]);
  const staged = await stageArchive([
    { name: 'Sonic.zip', body: buildZip([{ name: 'Sonic.md', body: rom, compress: true }]) },
  ]);
  try {
    const entry = await openVirtualEntry(staged.root, staged.sha256, staged.registry, '0.0');
    assert.ok(entry);
    assert.notEqual(entry.path, staged.path);
    assert.equal(entry.size, rom.length);
    assert.equal((await cachedFiles(staged.root)).length, 1);
    const middle = await readRange(entry.path, 1000, 1099);
    assert.deepEqual(middle, rom.subarray(1000, 1100));
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('listing never expands a compressed container until it is asked to', async () => {
  const rom = randomBytes(2048);
  const inner = buildZip([{ name: 'Sonic.md', body: rom }]);
  const staged = await stageArchive([{ name: 'Sonic.zip', body: inner, compress: true }]);
  try {
    const shallow = await listVirtualEntries(staged.root, staged.sha256, staged.registry);
    assert.deepEqual(
      shallow?.entries.map((entry) => entry.entryId),
      ['0'],
    );
    assert.deepEqual(await cachedFiles(staged.root), []);

    const deep = await listVirtualEntries(staged.root, staged.sha256, staged.registry, '0');
    assert.deepEqual(
      deep?.entries.map((entry) => [entry.entryId, entry.path]),
      [['0.0', 'Sonic.zip/Sonic.md']],
    );
    assert.equal((await cachedFiles(staged.root)).length, 1);

    const entry = await openVirtualEntry(staged.root, staged.sha256, staged.registry, '0.0');
    assert.ok(entry);
    const head = await readRange(entry.path, entry.offset, entry.offset + 99);
    assert.deepEqual(head, rom.subarray(0, 100));
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('a recursive bomb is refused while enumerating the nested tree', async () => {
  const inner = buildZip([{ name: 'bomb.bin', body: Buffer.alloc(128 * 1024), compress: true }]);
  const staged = await stageArchive([{ name: 'set.zip', body: inner }]);
  try {
    await assert.rejects(staged.registry.inspect(staged.path), { code: 'archive-rejected' });
    assert.deepEqual(await cachedFiles(staged.root), []);
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('the entry budget is spent across the whole nested tree', async () => {
  const members = Array.from({ length: 5 }, (_value, index) => ({
    name: `part-${index}.bin`,
    body: randomBytes(16),
  }));
  const staged = await stageArchive([
    { name: 'left.zip', body: buildZip(members) },
    { name: 'right.zip', body: buildZip(members) },
  ]);
  try {
    await assert.rejects(staged.registry.inspect(staged.path), { code: 'archive-rejected' });
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('nesting deeper than the quota allows is refused', async () => {
  const core = buildZip([{ name: 'Sonic.md', body: randomBytes(512) }]);
  const middle = buildZip([{ name: 'Sonic.zip', body: core }]);
  const staged = await stageArchive([{ name: 'set.zip', body: middle }]);
  try {
    const inspected = await staged.registry.inspect(staged.path);
    assert.deepEqual(
      inspected?.entries.map((entry) => entry.entryId),
      ['0.0'],
    );
    await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0.0.0'), {
      code: 'archive-rejected',
    });
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('an archive extension on an opaque member is not a reason to refuse the archive', async () => {
  const staged = await stageArchive([{ name: 'bundle.rar', body: randomBytes(512) }]);
  try {
    const inspected = await staged.registry.inspect(staged.path);
    assert.deepEqual(
      inspected?.entries.map((entry) => entry.path),
      ['bundle.rar'],
    );
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('a hostile compression ratio is refused before the cache grows', async () => {
  const staged = await stageArchive([
    { name: 'bomb.bin', body: Buffer.alloc(128 * 1024), compress: true },
  ]);
  try {
    await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
      code: 'archive-rejected',
    });
    assert.deepEqual(await cachedFiles(staged.root), []);
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('an entry that expands past its declared size leaves nothing behind', async () => {
  const body = randomBytes(4000);
  const staged = await stageArchive([
    { name: 'forged.bin', body, compress: true, declaredSize: 2000 },
  ]);
  try {
    await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
      code: 'archive-rejected',
    });
    assert.deepEqual(await cachedFiles(staged.root), []);
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('an entry that fails its CRC check is refused', async () => {
  const staged = await stageArchive([
    { name: 'torn.bin', body: randomBytes(4000), compress: true, declaredCrc: 1 },
  ]);
  try {
    await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
      code: 'archive-rejected',
    });
    assert.deepEqual(await cachedFiles(staged.root), []);
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('an entry name that escapes its own tree is refused', async () => {
  const staged = await stageArchive([{ name: '../escape.bin', body: randomBytes(64) }]);
  try {
    await assert.rejects(staged.registry.inspect(staged.path), { code: 'archive-rejected' });
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('more entries than the quota allows is refused', async () => {
  const members = Array.from({ length: QUOTA.maxEntries + 1 }, (_value, index) => ({
    name: `part-${index}.bin`,
    body: randomBytes(16),
  }));
  const staged = await stageArchive(members);
  try {
    await assert.rejects(staged.registry.inspect(staged.path), { code: 'archive-rejected' });
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('an unknown entry id resolves to nothing rather than an error', async () => {
  const staged = await stageArchive([{ name: 'disc.bin', body: randomBytes(64) }]);
  try {
    assert.equal(await openVirtualEntry(staged.root, staged.sha256, staged.registry, '9'), null);
    assert.equal(
      await openVirtualEntry(staged.root, staged.sha256, staged.registry, 'not-an-index'),
      null,
    );
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('a file that is not an archive reports no virtual format', async () => {
  const staged = await stageArchive([{ name: 'disc.bin', body: randomBytes(64) }]);
  try {
    const plain = join(staged.root, 'plain.bin');
    await writeFile(plain, randomBytes(512));
    assert.equal(await staged.registry.inspect(plain), null);
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});
