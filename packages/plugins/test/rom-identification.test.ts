import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateRomFacts } from '../src/rom-facts.js';
import { identifyRom } from '../src/rom-identification.js';

const blank = () => ({
  version: 1 as const,
  pluginIds: [],
  hashes: [],
  identifiers: [],
  names: [],
  warnings: [],
});
test('ROM facts validator bounds evidence, validates digest shapes, and copies plugin output', () => {
  const original = {
    ...blank(),
    pluginIds: ['test.reader'],
    hashes: [
      {
        algorithm: 'md5' as const,
        value: 'A'.repeat(32),
        size: 9,
        representation: 'raw',
        verified: true,
      },
    ],
  };
  const copied = validateRomFacts(original);
  assert.equal(copied.hashes[0]?.value, 'a'.repeat(32));
  assert.ok(original.hashes[0]);
  original.hashes[0].value = 'b'.repeat(32);
  assert.equal(copied.hashes[0]?.value, 'a'.repeat(32));
  for (const invalid of [
    { ...blank(), version: 2 },
    {
      ...blank(),
      hashes: [{ algorithm: 'md5', value: 'no', size: 1, representation: 'raw', verified: true }],
    },
    { ...blank(), names: Array(33).fill('a') },
    { ...blank(), warnings: ['secret\nline'] },
    { ...blank(), extra: true },
    { ...blank(), pluginIds: ['test.reader', 'test.reader'] },
  ])
    assert.throws(() => validateRomFacts(invalid), /Invalid ROM/);
});
async function generated(bytes: Buffer, name = 'generated.j64', systemId: string | null = null) {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-identify-'));
  const path = join(directory, name);
  await writeFile(path, bytes);
  return { directory, request: { path, name, systemId, size: bytes.length } };
}
test('ordinary ROM bytes produce verified raw MD5, SHA1 and CRC32 without arbitrary trimming', async () => {
  const f = await generated(Buffer.from('123456789'));
  try {
    const facts = await identifyRom(f.request);
    assert.equal(
      facts.hashes.find((h) => h.algorithm === 'md5')?.value,
      createHash('md5').update('123456789').digest('hex'),
    );
    assert.equal(
      facts.hashes.find((h) => h.algorithm === 'sha1')?.value,
      createHash('sha1').update('123456789').digest('hex'),
    );
    assert.equal(facts.hashes.find((h) => h.algorithm === 'crc32')?.value, 'cbf43926');
    assert.ok(facts.hashes.every((h) => h.verified && h.representation === 'raw' && h.size === 9));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
for (const name of [
  'generated.zip',
  'generated.7z',
  'generated.chd',
  'generated.rvz',
  'generated.ciso',
])
  test(`${name} never exposes a container checksum as a raw game hash`, async () => {
    const f = await generated(Buffer.from('not a valid container'), name);
    try {
      assert.ok((await identifyRom(f.request)).hashes.every((h) => h.representation !== 'raw'));
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
test('NES normalization requires a complete format-declared payload and excludes a declared trainer', async () => {
  const payload = Buffer.alloc(16384, 0x42),
    header = Buffer.alloc(16);
  header.write('NES\x1a', 0, 'binary');
  header[4] = 1;
  header[6] = 4;
  const f = await generated(
    Buffer.concat([header, Buffer.alloc(512, 0x33), payload]),
    'generated.nes',
  );
  try {
    const facts = await identifyRom(f.request);
    const normalized = facts.hashes.find(
      (h) => h.algorithm === 'md5' && h.representation === 'nes-prg-chr',
    );
    assert.equal(normalized?.value, createHash('md5').update(payload).digest('hex'));
    assert.equal(normalized?.size, payload.length);
    await writeFile(f.request.path, Buffer.concat([header, payload]));
    const invalid = await identifyRom({ ...f.request, size: 16 + payload.length });
    assert.ok(!invalid.hashes.some((h) => h.representation === 'nes-prg-chr'));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test('SNES copier-header normalization requires size, internal mapping, reset vector and actual checksum agreement', async () => {
  const payload = Buffer.alloc(32768),
    at = 0x7fc0;
  payload.write('GENERATED HOMEBREW    ', at, 'ascii');
  payload[at + 21] = 0x20;
  payload[at + 23] = 5;
  payload.writeUInt16LE(0x8000, at + 60);
  const checksum = (payload.reduce((sum, b) => sum + b, 0) + 510) & 65535;
  payload.writeUInt16LE(checksum ^ 65535, at + 28);
  payload.writeUInt16LE(checksum, at + 30);
  const f = await generated(
    Buffer.concat([Buffer.alloc(512), payload]),
    'generated.smc',
    'com.provenance.snes',
  );
  try {
    let facts = await identifyRom(f.request);
    assert.equal(
      facts.hashes.find(
        (h) => h.algorithm === 'md5' && h.representation === 'snes-no-copier-header',
      )?.value,
      createHash('md5').update(payload).digest('hex'),
    );
    payload[0] = 1;
    await writeFile(f.request.path, Buffer.concat([Buffer.alloc(512), payload]));
    facts = await identifyRom(f.request);
    assert.ok(!facts.hashes.some((h) => h.representation === 'snes-no-copier-header'));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test('CHD v5 header SHA1 is declared evidence with logical size, never verified game bytes', async () => {
  const header = Buffer.alloc(128);
  header.write('MComprHD');
  header.writeUInt32BE(124, 8);
  header.writeUInt32BE(5, 12);
  header.writeBigUInt64BE(2048n, 32);
  header.writeBigUInt64BE(124n, 40);
  header.writeUInt32BE(4096, 56);
  header.writeUInt32BE(2048, 60);
  header.fill(0x11, 64, 84);
  header.fill(0x22, 84, 104);
  const f = await generated(header, 'generated.chd');
  try {
    const facts = await identifyRom(f.request);
    assert.equal(facts.hashes.length, 2);
    assert.ok(facts.hashes.every((h) => h.algorithm === 'sha1' && !h.verified && h.size === 2048));
    assert.ok(facts.warnings.length);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test('identification cancels before reads and isolates malformed additional-plugin facts', async () => {
  const f = await generated(Buffer.from('123456789'));
  try {
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(identifyRom(f.request, abort.signal));
    const facts = await identifyRom(f.request, undefined, [
      { id: 'test.invalid', supports: () => true, identify: async () => ({ version: 2 }) as never },
    ]);
    assert.ok(facts.warnings.some((w) => w.includes('test.invalid')));
    assert.ok(facts.hashes.some((h) => h.representation === 'raw'));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('GameCube identifiers require disc magic and source replacement invalidates all facts', async () => {
  const { rename } = await import('node:fs/promises');
  const bytes = Buffer.alloc(0x440);
  bytes.write('HBRE01', 0, 'ascii');
  bytes.writeUInt32BE(0xc2339f3d, 0x1c);
  const f = await generated(bytes, 'generated.gcm');
  try {
    const facts = await identifyRom(f.request);
    assert.deepEqual(facts.identifiers, [
      { type: 'serial', value: 'HBRE01', systemId: 'com.provenance.gamecube', verified: true },
    ]);
    await assert.rejects(
      identifyRom(f.request, undefined, [
        {
          id: 'test.replace',
          supports: () => true,
          identify: async () => {
            await rename(f.request.path, join(f.directory, 'old'));
            await writeFile(f.request.path, bytes);
            return blank();
          },
        },
      ]),
      /source-changed/,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('bounded readers reject over-budget requests and private diagnostics never become facts warnings', async () => {
  const f = await generated(Buffer.from('123456789'));
  try {
    const facts = await identifyRom(f.request, undefined, [
      {
        id: 'test.range',
        supports: () => true,
        identify: async (_request, reader) => {
          await reader.read(0, 2 * 1024 * 1024);
          return blank();
        },
      },
      {
        id: 'test.secret',
        supports: () => true,
        identify: async () => ({ ...blank(), warnings: ['failed /private/operator/path'] }),
      },
    ]);
    assert.ok(facts.warnings.includes('test.range:unsupported-or-unavailable'));
    assert.ok(facts.warnings.includes('test.secret:unsupported-or-unavailable'));
    assert.ok(facts.warnings.every((warning) => !warning.includes('/')));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('normalization crosses stream-prefix boundaries without losing or repeating payload bytes', async () => {
  const header = Buffer.alloc(16);
  header.write('NES\x1a', 0, 'binary');
  header[4] = 16;
  header[6] = 4;
  const payload = Buffer.alloc(16 * 16384, 0x42),
    f = await generated(Buffer.concat([header, Buffer.alloc(512), payload]), 'generated.nes');
  try {
    const facts = await identifyRom(f.request);
    assert.equal(
      facts.hashes.find(
        (hash) => hash.algorithm === 'sha1' && hash.representation === 'nes-prg-chr',
      )?.value,
      createHash('sha1').update(payload).digest('hex'),
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('cancellation returns even when an additional async plugin ignores its signal', async () => {
  const f = await generated(Buffer.from('123456789'));
  const abort = new AbortController();
  try {
    await assert.rejects(
      identifyRom(f.request, abort.signal, [
        {
          id: 'test.pending',
          supports: () => true,
          identify: async () => {
            queueMicrotask(() => abort.abort());
            return await new Promise(() => {});
          },
        },
      ]),
      { name: 'AbortError' },
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('known container signatures are declined even when an archive is renamed to a ROM extension', async () => {
  for (const signature of [
    Buffer.from([0x50, 0x4b, 3, 4]),
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
    Buffer.from('MComprHD'),
    Buffer.from('CISO'),
    Buffer.from([0x52, 0x56, 0x5a, 1]),
  ]) {
    const f = await generated(Buffer.concat([signature, Buffer.alloc(128)]), 'renamed.j64');
    try {
      assert.deepEqual((await identifyRom(f.request)).hashes, []);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test('NES declared payload permits only bounded uniform padding and retains the original raw hash', async () => {
  const header = Buffer.alloc(16);
  header.write('NES\x1a', 0, 'binary');
  header[4] = 1;
  const payload = Buffer.alloc(16384, 0x42);
  for (const pad of [0, 255]) {
    const bytes = Buffer.concat([header, payload, Buffer.alloc(150000, pad)]),
      f = await generated(bytes, 'padded.nes');
    try {
      let facts = await identifyRom(f.request);
      assert.equal(
        facts.hashes.find(
          (hash) => hash.algorithm === 'md5' && hash.representation === 'nes-prg-chr',
        )?.value,
        createHash('md5').update(payload).digest('hex'),
      );
      assert.equal(
        facts.hashes.find((hash) => hash.algorithm === 'md5' && hash.representation === 'raw')
          ?.value,
        createHash('md5').update(bytes).digest('hex'),
      );
      bytes[bytes.length - 1] = 1;
      await writeFile(f.request.path, bytes);
      facts = await identifyRom(f.request);
      assert.ok(!facts.hashes.some((hash) => hash.representation === 'nes-prg-chr'));
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});
