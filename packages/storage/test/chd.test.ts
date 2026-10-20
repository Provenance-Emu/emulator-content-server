import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { DomainError } from '@ecs/domain';
import { VirtualProviderRegistry } from '../src/virtual.js';
import { ZipProvider } from '../src/zip.js';
import { fixture, probeRunner, QUOTA, synthetic, track } from './chd-fixture.js';

test('DVD listing requires a validated marker and preserves exact logical length without decoding', async () => {
  let calls = 0;
  const f = await fixture(synthetic(), (...args) => {
    calls += 1;
    return probeRunner(...args);
  });
  try {
    assert.deepEqual(await f.provider.inspect(f.path, QUOTA), {
      entries: [
        {
          entryId: '0',
          path: 'disc.iso',
          compressedSize: 157,
          uncompressedSize: 4096,
          method: 'chd-dvd',
        },
      ],
    });
    assert.equal((await f.provider.resolve?.(f.path, '0', QUOTA))?.kind, 'bundle');
    assert.equal(await f.provider.resolve?.(f.path, '1', QUOTA), null);
    assert.equal(calls, 2, 'only the two startup command probes may spawn');
  } finally {
    await f.cleanup();
  }
});

test('ZIP dispatch lets the CHD provider handle a stale deep entry id', async () => {
  const f = await fixture(synthetic());
  const registry = new VirtualProviderRegistry([new ZipProvider(), f.provider], QUOTA);
  try {
    assert.equal(await registry.resolve(f.path, '0.0.0'), null);
    const found = await registry.resolve(f.path, '0');
    assert.equal(found?.format, 'chd');
    assert.equal(found?.resolution.kind, 'bundle');
  } finally {
    await f.cleanup();
  }
});

test('mixed CD listing derives CUE size and frame offsets without counting internal padding', async () => {
  const f = await fixture(
    synthetic([track(1, 'MODE1', 76), track(2, 'AUDIO', 75), track(3, 'MODE2_RAW', 1)], false),
  );
  try {
    const entries = (await f.provider.inspect(f.path, QUOTA))?.entries;
    assert.deepEqual(
      entries?.map((e) => [e.entryId, e.path, e.uncompressedSize, e.method]),
      [
        ['0', 'disc.cue', 150, 'chd-cue-bin'],
        ['1', 'disc.bin', 334400, 'chd-cue-bin'],
      ],
    );
  } finally {
    await f.cleanup();
  }
});

for (const [name, mutate] of [
  ['version', (b: Buffer) => b.writeUInt32BE(4, 12)],
  ['header length', (b: Buffer) => b.writeUInt32BE(120, 8)],
  [
    'parent',
    (b: Buffer) => {
      b[104] = 1;
    },
  ],
  ['unsafe logical bytes', (b: Buffer) => b.writeBigUInt64BE(9007199254740992n, 32)],
  ['unit alignment', (b: Buffer) => b.writeUInt32BE(512, 60)],
  ['zero hunks', (b: Buffer) => b.writeUInt32BE(0, 56)],
  ['bad map', (b: Buffer) => b.writeBigUInt64BE(9999n, 40)],
  ['cyclic metadata', (b: Buffer) => b.writeBigUInt64BE(140n, 148)],
  ['out-of-file metadata', (b: Buffer) => b.writeBigUInt64BE(9999n, 148)],
  ['truncated metadata', (b: Buffer) => b.writeUIntBE(999, 145, 3)],
] as const) {
  test(`CHD rejects ${name} before decode`, async () => {
    const bytes = synthetic();
    mutate(bytes);
    const f = await fixture(bytes);
    try {
      await assert.rejects(
        f.provider.inspect(f.path, QUOTA),
        (error) => error instanceof DomainError,
      );
    } finally {
      await f.cleanup();
    }
  });
}
for (const [name, tags, dvd] of [
  ['missing marker', [], true],
  [
    'duplicate DVD',
    [
      ['DVD ', ''],
      ['DVD ', ''],
    ],
    true,
  ],
  ['conflicting disc tags', [['DVD ', ''], track(1, 'MODE1', 1)], true],
  ['legacy CD', [['CHTR', 'TRACK:1 TYPE:MODE1 SUBTYPE:NONE FRAMES:1']], false],
  ['GD ROM', [['CHGD', '']], false],
  ['multisession', [track(1, 'MODE1', 1), ['CHSE', 'SESSION:2']], false],
  ['duplicate tracks', [track(1, 'AUDIO', 1), track(1, 'AUDIO', 1)], false],
  ['nonsequential tracks', [track(2, 'AUDIO', 1)], false],
  ['unsupported mode', [track(1, 'MODE2', 1)], false],
  ['subchannels', [['CHT2', track(1, 'MODE1', 1)[1].replace('SUBTYPE:NONE', 'SUBTYPE:RW')]], false],
  ['pregap', [['CHT2', track(1, 'MODE1', 1)[1].replace('PREGAP:0', 'PREGAP:1')]], false],
  ['postgap', [['CHT2', track(1, 'MODE1', 1)[1].replace('POSTGAP:0', 'POSTGAP:1')]], false],
  ['zero frames', [track(1, 'AUDIO', 0)], false],
  ['unsafe frames', [track(1, 'AUDIO', 9007199254740992)], false],
  [
    'metadata record limit',
    Array.from({ length: 129 }, () => ['JUNK', ''] as [string, string]),
    true,
  ],
  [
    'metadata byte limit',
    [
      ['JUNK', 'x'.repeat(65536)],
      ['DVD ', ''],
    ],
    true,
  ],
] as [string, [string, string][], boolean][]) {
  test(`CHD rejects ${name}`, async () => {
    const f = await fixture(synthetic(tags, dvd));
    try {
      await assert.rejects(
        f.provider.inspect(f.path, QUOTA),
        (error) => error instanceof DomainError,
      );
    } finally {
      await f.cleanup();
    }
  });
}

test('CHD ignores other formats, rejects truncation and windows, and applies complete-group quotas', async () => {
  const f = await fixture(synthetic([track(1, 'MODE1_RAW', 1)], false));
  try {
    const entries = (await f.provider.inspect(f.path, QUOTA))?.entries;
    assert.equal(entries?.[1]?.uncompressedSize, 2352);
    await assert.rejects(f.provider.inspect(f.path, QUOTA, { offset: 0, length: 100 }));
    for (const quota of [
      { ...QUOTA, maxEntries: 1 },
      { ...QUOTA, maxExpandedBytes: 2352 },
      { ...QUOTA, maxCompressionRatio: 1 },
    ])
      await assert.rejects(
        f.provider.inspect(f.path, quota),
        (error) => error instanceof DomainError,
      );
    await writeFile(f.path, Buffer.from('MComprHD'));
    await assert.rejects(
      f.provider.inspect(f.path, QUOTA),
      (error) => error instanceof DomainError,
    );
    await writeFile(f.path, Buffer.from('unrelated'));
    assert.equal(await f.provider.inspect(f.path, QUOTA), null);
  } finally {
    await f.cleanup();
  }
});

test('a zero nesting budget rejects CHD rather than resetting the expansion budget', async () => {
  const f = await fixture(synthetic());
  try {
    await assert.rejects(f.provider.inspect(f.path, { ...QUOTA, maxNesting: 0 }));
  } finally {
    await f.cleanup();
  }
});
