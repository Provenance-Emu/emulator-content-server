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
  compressedBody?: Buffer;
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
    const payload = member.compress
      ? (member.compressedBody ?? deflateRawSync(member.body))
      : member.body;
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

async function stageArchive(members: Member[] | Buffer, quota = QUOTA): Promise<Staged> {
  const root = await mkdtemp(join(tmpdir(), 'ecs-zip-'));
  await ensureLayout(root);
  const source = join(root, 'archive.zip');
  await writeFile(source, Buffer.isBuffer(members) ? members : buildZip(members));
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

for (const entryId of ['0', '0.0.0']) {
  test(`ZIP resolution ignores a non-archive with entry id ${entryId}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'ecs-zip-'));
    try {
      const plain = join(root, 'plain.bin');
      await writeFile(plain, Buffer.alloc(512, 7));
      assert.equal(await new ZipProvider().resolve(plain, entryId, QUOTA), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

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

for (const nested of [false, true]) {
  test(`the expanded-byte budget is shared across ${nested ? 'nested branches' : 'sibling entries'}`, async () => {
    const leaves = [
      { name: 'left.bin', body: randomBytes(2048), compress: true },
      { name: 'right.bin', body: randomBytes(2049), compress: true },
    ];
    const members = nested
      ? leaves.map((leaf, index) => ({ name: `branch-${index}.zip`, body: buildZip([leaf]) }))
      : leaves;
    const staged = await stageArchive(members, { ...QUOTA, maxExpandedBytes: 4096 });
    try {
      await assert.rejects(staged.registry.inspect(staged.path), { code: 'archive-rejected' });
      assert.deepEqual(await cachedFiles(staged.root), []);
      const atBoundary = new VirtualProviderRegistry([new ZipProvider()], {
        ...QUOTA,
        maxExpandedBytes: 4097,
      });
      const accepted = await atBoundary.inspect(staged.path);
      assert.deepEqual(
        accepted?.entries.map((entry) => entry.uncompressedSize),
        [2048, 2049],
      );
      assert.deepEqual(await cachedFiles(staged.root), []);
    } finally {
      await rm(staged.root, { recursive: true, force: true });
    }
  });
}

test('a direct entry request cannot bypass the expanded-size quota by skipping inspection', async () => {
  const staged = await stageArchive(
    [{ name: 'oversized.bin', body: randomBytes(4097), compress: true }],
    { ...QUOTA, maxExpandedBytes: 4096 },
  );
  try {
    await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
      code: 'archive-rejected',
    });
    assert.deepEqual(await cachedFiles(staged.root), []);
    await assert.rejects(staged.registry.inspect(staged.path), { code: 'archive-rejected' });
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('repeated forged expansion failures leave no cache and do not block a healthy entry', async () => {
  const healthy = Buffer.from('healthy generated bytes');
  const staged = await stageArchive([
    { name: 'forged.bin', body: Buffer.alloc(128 * 1024), compress: true, declaredSize: 1024 },
    { name: 'healthy.bin', body: healthy, compress: true },
  ]);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
        code: 'archive-rejected',
      });
      assert.deepEqual(await cachedFiles(staged.root), []);
    }
    const entry = await openVirtualEntry(staged.root, staged.sha256, staged.registry, '1');
    assert.ok(entry);
    assert.equal(entry.size, healthy.length);
    assert.deepEqual(await readRange(entry.path, 0, healthy.length - 1), healthy);
    const cached = await cachedFiles(staged.root);
    assert.equal(cached.length, 1);
    assert.equal(
      cached.some((name) => name.endsWith('.partial')),
      false,
    );
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

test('compressed containers cannot reset the nesting budget during expansion', async () => {
  const core = buildZip([{ name: 'generated.bin', body: randomBytes(1024) }]);
  const middle = buildZip([{ name: 'core.zip', body: core, compress: true }]);
  const staged = await stageArchive([{ name: 'middle.zip', body: middle, compress: true }]);
  try {
    await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0.0.0'), {
      code: 'archive-rejected',
    });
    assert.deepEqual(await cachedFiles(staged.root), []);
    const atBoundary = await openVirtualEntry(staged.root, staged.sha256, staged.registry, '0.0');
    assert.ok(atBoundary);
    assert.deepEqual(await readRange(atBoundary.path, 0, core.length - 1), core);
  } finally {
    await rm(staged.root, { recursive: true, force: true });
  }
});

for (const declaredSize of [0, 2, 4096]) {
  test(`a stored entry cannot replace its four-byte extent with declared size ${declaredSize}`, async (t) => {
    const staged = await stageArchive([
      { name: 'forged.bin', body: Buffer.from('DATA'), declaredSize },
      { name: 'neighbor.bin', body: Buffer.from('neighbor sentinel') },
    ]);
    t.after(() => rm(staged.root, { recursive: true, force: true }));
    await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
      code: 'archive-rejected',
    });
    await assert.rejects(staged.registry.inspect(staged.path), { code: 'archive-rejected' });
    assert.deepEqual(await cachedFiles(staged.root), []);
  });
}

test('a stored container cannot hide a size mismatch by descending into its children', async (t) => {
  const inner = buildZip([{ name: 'generated.bin', body: Buffer.from('DATA') }]);
  const staged = await stageArchive([
    { name: 'forged.zip', body: inner, declaredSize: inner.length + 128 },
  ]);
  t.after(() => rm(staged.root, { recursive: true, force: true }));
  await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0.0'), {
    code: 'archive-rejected',
  });
  await assert.rejects(staged.registry.inspect(staged.path), { code: 'archive-rejected' });
  assert.deepEqual(await cachedFiles(staged.root), []);
});

test('valid stored extents keep adjacent entries separate and allow empty files', async (t) => {
  const staged = await stageArchive([
    { name: 'first.bin', body: Buffer.from('DATA') },
    { name: 'second.bin', body: Buffer.from('NEIGHBOR') },
    { name: 'empty.bin', body: Buffer.alloc(0) },
  ]);
  t.after(() => rm(staged.root, { recursive: true, force: true }));
  const inspected = await staged.registry.inspect(staged.path);
  assert.deepEqual(
    inspected?.entries.map((entry) => entry.uncompressedSize),
    [4, 8, 0],
  );
  for (const input of [
    { id: '0', body: 'DATA' },
    { id: '1', body: 'NEIGHBOR' },
  ]) {
    const entry = await openVirtualEntry(staged.root, staged.sha256, staged.registry, input.id);
    assert.ok(entry);
    assert.equal(entry.size, input.body.length);
    assert.equal(entry.path, staged.path);
    assert.deepEqual(
      await readRange(entry.path, entry.offset, entry.offset + entry.size - 1),
      Buffer.from(input.body),
    );
  }
  const empty = await openVirtualEntry(staged.root, staged.sha256, staged.registry, '2');
  assert.ok(empty);
  assert.equal(empty.size, 0);
  assert.deepEqual(await cachedFiles(staged.root), []);
});

for (const corruption of ['invalid block', 'truncated stream'] as const) {
  test(`corrupt DEFLATE (${corruption}) returns an archive error and cleans up`, async (t) => {
    const body = Buffer.from('generated compressed bytes '.repeat(100));
    const compressedBody =
      corruption === 'invalid block' ? Buffer.from([0x07]) : deflateRawSync(body).subarray(0, -1);
    const healthy = Buffer.from('healthy neighbor');
    const staged = await stageArchive([
      { name: 'corrupt.bin', body, compress: true, compressedBody },
      { name: 'healthy.bin', body: healthy, compress: true },
    ]);
    t.after(() => rm(staged.root, { recursive: true, force: true }));
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
        code: 'archive-rejected',
        status: 422,
      });
      assert.deepEqual(await cachedFiles(staged.root), []);
    }
    const entry = await openVirtualEntry(staged.root, staged.sha256, staged.registry, '1');
    assert.ok(entry);
    assert.deepEqual(await readRange(entry.path, 0, healthy.length - 1), healthy);
    assert.equal((await cachedFiles(staged.root)).length, 1);
  });
}

for (const neighboring of [false, true]) {
  test(`a ZIP member cannot extend into ${neighboring ? 'the next local header' : 'the central directory'}`, async (t) => {
    const archive = buildZip([
      { name: 'first.bin', body: Buffer.from('DATA') },
      ...(neighboring ? [{ name: 'second.bin', body: Buffer.from('NEIGHBOR') }] : []),
    ]);
    const directory = archive.readUInt32LE(archive.length - 6);
    archive.writeUInt32LE(32, 18);
    archive.writeUInt32LE(32, 22);
    archive.writeUInt32LE(32, directory + 20);
    archive.writeUInt32LE(32, directory + 24);
    const staged = await stageArchive(archive);
    t.after(() => rm(staged.root, { recursive: true, force: true }));
    await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
      code: 'archive-rejected',
      status: 422,
    });
    assert.deepEqual(await cachedFiles(staged.root), []);
  });
}

test('a forged local extra length cannot shift member data into its neighbor', async (t) => {
  const archive = buildZip([
    { name: 'first.bin', body: Buffer.from('DATA') },
    { name: 'second.bin', body: Buffer.from('NEIGHBOR') },
  ]);
  archive.writeUInt16LE(4, 28);
  const staged = await stageArchive(archive);
  t.after(() => rm(staged.root, { recursive: true, force: true }));
  await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
    code: 'archive-rejected',
    status: 422,
  });
  assert.deepEqual(await cachedFiles(staged.root), []);
});

test('physical member boundaries do not depend on central-directory ordering', async (t) => {
  const archive = buildZip([
    { name: 'first.bin', body: Buffer.from('DATA') },
    { name: 'second.bin', body: Buffer.from('NEIGHBOR') },
  ]);
  const directory = archive.readUInt32LE(archive.length - 6);
  const firstEnd = directory + 46 + Buffer.byteLength('first.bin');
  const reordered = Buffer.concat([
    archive.subarray(0, directory),
    archive.subarray(firstEnd, archive.length - 22),
    archive.subarray(directory, firstEnd),
    archive.subarray(archive.length - 22),
  ]);
  const staged = await stageArchive(reordered);
  t.after(() => rm(staged.root, { recursive: true, force: true }));
  for (const input of [
    { id: '0', body: 'NEIGHBOR' },
    { id: '1', body: 'DATA' },
  ]) {
    const entry = await openVirtualEntry(staged.root, staged.sha256, staged.registry, input.id);
    assert.ok(entry);
    assert.deepEqual(
      await readRange(entry.path, entry.offset, entry.offset + entry.size - 1),
      Buffer.from(input.body),
    );
  }
});

for (const compress of [false, true]) {
  for (const mismatch of ['method', 'encryption'] as const) {
    test(`ZIP local ${mismatch} must agree with the central directory (${compress ? 'deflated' : 'stored'})`, async (t) => {
      const archive = buildZip([
        { name: 'generated.bin', body: Buffer.from('generated payload'), compress },
      ]);
      if (mismatch === 'method') archive.writeUInt16LE(compress ? 0 : 8, 8);
      else archive.writeUInt16LE(1, 6);
      const staged = await stageArchive(archive);
      t.after(() => rm(staged.root, { recursive: true, force: true }));
      await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
        code: 'archive-rejected',
        status: 422,
      });
      assert.deepEqual(await cachedFiles(staged.root), []);
    });
  }
}

for (const suffix of ['junk', 'second stream'] as const) {
  test(`DEFLATE rejects trailing ${suffix} within the declared compressed extent`, async (t) => {
    const body = Buffer.from('generated payload');
    const compressedBody = Buffer.concat([
      deflateRawSync(body),
      suffix === 'junk' ? Buffer.from('unexpected bytes') : deflateRawSync(Buffer.from('hidden')),
    ]);
    const staged = await stageArchive([
      { name: 'generated.bin', body, compress: true, compressedBody },
    ]);
    t.after(() => rm(staged.root, { recursive: true, force: true }));
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
        code: 'archive-rejected',
        status: 422,
      });
      assert.deepEqual(await cachedFiles(staged.root), []);
    }
  });
}

for (const field of ['disk number', 'directory disk', 'disk entry count', 'member disk'] as const) {
  test(`split-volume ZIP metadata rejects ${field}`, async (t) => {
    const archive = buildZip([{ name: 'generated.bin', body: Buffer.from('DATA') }]);
    const end = archive.length - 22;
    const directory = archive.readUInt32LE(end + 16);
    if (field === 'disk number') archive.writeUInt16LE(1, end + 4);
    if (field === 'directory disk') archive.writeUInt16LE(1, end + 6);
    if (field === 'disk entry count') archive.writeUInt16LE(0, end + 8);
    if (field === 'member disk') archive.writeUInt16LE(1, directory + 34);
    const staged = await stageArchive(archive);
    t.after(() => rm(staged.root, { recursive: true, force: true }));
    await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
      code: 'archive-rejected',
      status: 422,
    });
    assert.deepEqual(await cachedFiles(staged.root), []);
  });
}

for (const field of [
  'valid',
  'valid extension',
  'short record',
  'overlong record',
  'locator disk',
  'volume count',
  'record disk',
  'directory disk',
  'disk entry count',
] as const) {
  test(`ZIP64 volume metadata: ${field}`, async (t) => {
    const original = buildZip([{ name: 'generated.bin', body: Buffer.from('DATA') }]);
    const endOffset = original.length - 22;
    const end = Buffer.from(original.subarray(endOffset));
    const record = Buffer.alloc(field === 'valid extension' ? 60 : 56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(field === 'valid extension' ? 48n : 44n, 4);
    if (field === 'short record') record.writeBigUInt64LE(43n, 4);
    if (field === 'overlong record') record.writeBigUInt64LE(45n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(1n, 24);
    record.writeBigUInt64LE(1n, 32);
    record.writeBigUInt64LE(BigInt(end.readUInt32LE(12)), 40);
    record.writeBigUInt64LE(BigInt(end.readUInt32LE(16)), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(endOffset), 8);
    locator.writeUInt32LE(1, 16);
    end.writeUInt16LE(0xffff, 8);
    end.writeUInt16LE(0xffff, 10);
    if (field === 'locator disk') locator.writeUInt32LE(1, 4);
    if (field === 'volume count') locator.writeUInt32LE(2, 16);
    if (field === 'record disk') record.writeUInt32LE(1, 16);
    if (field === 'directory disk') record.writeUInt32LE(1, 20);
    if (field === 'disk entry count') record.writeBigUInt64LE(0n, 24);
    const staged = await stageArchive(
      Buffer.concat([original.subarray(0, endOffset), record, locator, end]),
    );
    t.after(() => rm(staged.root, { recursive: true, force: true }));
    if (field === 'valid' || field === 'valid extension') {
      const entry = await openVirtualEntry(staged.root, staged.sha256, staged.registry, '0');
      assert.ok(entry);
      assert.deepEqual(
        await readRange(entry.path, entry.offset, entry.offset + entry.size - 1),
        Buffer.from('DATA'),
      );
    } else {
      await assert.rejects(openVirtualEntry(staged.root, staged.sha256, staged.registry, '0'), {
        code: 'archive-rejected',
        status: 422,
      });
    }
    assert.deepEqual(await cachedFiles(staged.root), []);
  });
}
