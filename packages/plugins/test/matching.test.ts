import assert from 'node:assert/strict';
import test from 'node:test';
import * as matching from '../src/matching.js';

const input = {
  name: 'Game (USA).rom',
  systemId: 'com.provenance.jaguar',
  size: 4,
  crc32: '12345678',
  companions: [],
};
test('manager ranks verified matches, keeps provenance, skips online without consent and isolates failures', async () => {
  let onlineCalls = 0;
  const providers = [
    {
      id: 'test.local',
      name: 'Local',
      capabilities: ['metadata'],
      network: false,
      search: async () => [
        { id: 'name', kind: 'metadata', title: 'Name', confidence: 'name', metadata: {} },
        { id: 'hash', kind: 'metadata', title: 'Verified', confidence: 'checksum', metadata: {} },
      ],
    },
    {
      id: 'test.online',
      name: 'Online',
      capabilities: ['metadata'],
      network: true,
      search: async () => {
        onlineCalls++;
        return [];
      },
    },
    {
      id: 'test.bad',
      name: 'Bad',
      capabilities: ['metadata'],
      network: false,
      search: async () => {
        throw new Error('private detail');
      },
    },
  ];
  const result = await matching.runMatching(input, providers as matching.MatchingProvider[]);
  assert.equal(onlineCalls, 0);
  assert.deepEqual(
    result.candidates.map((candidate) => [candidate.id, candidate.providerId]),
    [
      ['hash', 'test.local'],
      ['name', 'test.local'],
    ],
  );
  assert.deepEqual(result.problems, [{ providerId: 'test.bad', code: 'provider-failed' }]);
  assert.ok(!JSON.stringify(result).includes('private detail'));
  await matching.runMatching({ ...input, online: true }, providers as matching.MatchingProvider[]);
  assert.equal(onlineCalls, 1);
});

test('local provider matches exact sidecars and distinguishes unverified patches', async () => {
  const result = await matching.runMatching(
    {
      ...input,
      companions: [
        {
          id: 'meta',
          name: 'Game (USA).json',
          metadata: { title: 'My Game', publisher: 'Homebrew' },
        },
        { id: 'art', name: 'Game (USA).png' },
        { id: 'patch', name: 'Game (USA).ips', patch: { format: 'ips' } },
        { id: 'wrong', name: 'Game (Japan).png' },
      ],
    },
    [matching.localMatchingProvider],
  );
  assert.deepEqual(result.candidates.map((c) => c.kind).sort(), ['artwork', 'metadata', 'patch']);
  assert.equal(result.candidates.find((c) => c.kind === 'patch')?.confidence, 'name');
  assert.equal(
    result.candidates.find((c) => c.kind === 'metadata')?.metadata.publisher,
    'Homebrew',
  );
  assert.ok(result.candidates.every((c) => c.fileId !== 'wrong'));
});

test('Libretro DAT parser preserves parentheses and compares hash plus size before name', () => {
  const dat =
    'clrmamepro ( name "test" ) game ( name "Other (USA)" rom ( name "Other.bin" size 4 crc 12345678 md5 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ) ) game ( name "Game (USA)" rom ( name "Game.rom" size 8 crc 87654321 ) )';
  const records = matching.parseLibretroDat(dat);
  assert.equal(records[0]?.title, 'Other (USA)');
  const result = matching.matchLibretro(input, records);
  assert.equal(result[0]?.title, 'Other (USA)');
  assert.equal(result[0]?.confidence, 'checksum');
  assert.equal(result[1]?.confidence, 'name');
  assert.equal(
    matching.matchLibretro({ ...input, name: 'Renamed.rom', size: 5 }, records).length,
    0,
  );
});

test('matching output validation rejects undeclared capabilities and unsafe links', async () => {
  const provider = {
    id: 'test.bad',
    name: 'Bad',
    capabilities: ['metadata'],
    network: false,
    search: async () => [
      {
        id: 'x',
        kind: 'artwork',
        title: 'X',
        confidence: 'name',
        metadata: {},
        url: 'file:///private/key',
      },
    ],
  };
  const result = await matching.runMatching(input, [provider as matching.MatchingProvider]);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.problems[0]?.code, 'provider-failed');
});

test('online provider reads a bounded official catalog and produces attributed artwork hints', async () => {
  const { createLibretroProvider } = await import('../src/libretro-matching.js');
  const urls: string[] = [];
  const provider = createLibretroProvider(async (url) => {
    urls.push(String(url));
    return new Response(
      String(url).includes('/git/trees/')
        ? JSON.stringify({
            sha: 'a'.repeat(40),
            truncated: false,
            tree: [{ path: 'Named_Boxarts/Game (USA).png', type: 'blob', size: 1000 }],
          })
        : 'game ( name "Game (USA)" rom ( name "Game.rom" size 4 crc 12345678 ) )',
    );
  });
  const result = await matching.runMatching({ ...input, online: true }, [provider]);
  assert.equal(result.candidates[0]?.confidence, 'checksum');
  assert.ok(
    urls[0]?.startsWith(
      'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/',
    ),
  );
  assert.equal(
    result.candidates.find((c) => c.kind === 'artwork')?.url,
    'https://raw.githubusercontent.com/libretro-thumbnails/Atari_-_Jaguar/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Named_Boxarts/Game%20(USA).png',
  );
  await matching.runMatching({ ...input, online: true }, [provider]);
  assert.equal(urls.length, 3);
});

test('slow providers share one timeout window and do not discard successful results', async () => {
  const good = {
    ...matching.localMatchingProvider,
    search: async () => [
      {
        id: 'ok',
        kind: 'metadata' as const,
        title: 'Good',
        confidence: 'local' as const,
        metadata: {},
      },
    ],
  };
  const slow = Array.from({ length: 4 }, (_, index) => ({
    ...good,
    id: `test.slow${index}`,
    search: async (_input: matching.MatchingInput, signal?: AbortSignal) =>
      new Promise<matching.MatchCandidate[]>((_, reject) =>
        signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true }),
      ),
  }));
  const start = Date.now();
  // Keep Node alive while AbortSignal.timeout's unref timer is the only outstanding work.
  const alive = setInterval(() => undefined, 1000);
  try {
    const result = await matching.runMatching(input, [good, ...slow]);
    assert.equal(result.candidates[0]?.title, 'Good');
    assert.equal(result.problems.length, 4);
    assert.ok(Date.now() - start < 12000, 'Providers should share the same timeout window');
  } finally {
    clearInterval(alive);
  }
});

test('BPS and UPS patches expose base size and checksum only after patch integrity passes', async () => {
  const { crc32 } = await import('node:zlib');
  for (const signature of ['BPS1', 'UPS1']) {
    const patch = Buffer.concat([
      Buffer.from(signature),
      Buffer.from([0x84, 0x85, 0x80]),
      Buffer.alloc(12),
    ]);
    patch.writeUInt32LE(0x12345678, patch.length - 12);
    patch.writeUInt32LE(crc32(patch.subarray(0, -4)), patch.length - 4);
    assert.deepEqual(matching.patchFingerprint(patch), {
      format: signature === 'BPS1' ? 'bps' : 'ups',
      sourceSize: 4,
      sourceCrc32: '12345678',
    });
    patch[5] = 0xff;
    assert.equal(matching.patchFingerprint(patch), null);
  }
  assert.deepEqual(matching.patchFingerprint(Buffer.from('PATCHEOF')), { format: 'ips' });
});

test('verified BPS/UPS base identity matches a differently named patch, while mismatches are refused', async () => {
  const result = await matching.runMatching(
    {
      ...input,
      companions: [
        {
          id: 'verified',
          name: 'Fan translation.bps',
          patch: { format: 'bps', sourceCrc32: '12345678', sourceSize: 4 },
        },
        {
          id: 'wrong',
          name: 'Game (USA).bps',
          patch: { format: 'bps', sourceCrc32: '12345678', sourceSize: 5 },
        },
      ],
    },
    [matching.localMatchingProvider],
  );
  assert.deepEqual(
    result.candidates.map((c) => [c.fileId, c.confidence]),
    [['verified', 'checksum']],
  );
});

test('artwork offers the original filename when a checksum catalog uses a different edition title', async () => {
  const { createLibretroProvider } = await import('../src/libretro-matching.js');
  const provider = createLibretroProvider(
    async (url) =>
      new Response(
        String(url).includes('/git/trees/')
          ? JSON.stringify({
              sha: 'a'.repeat(40),
              truncated: false,
              tree: [
                { path: 'Named_Boxarts/Game (USA).png', type: 'blob', size: 1000 },
                { path: 'Named_Boxarts/Game (World).png', type: 'blob', size: 1000 },
              ],
            })
          : 'game ( name "Game (World)" rom ( name "Game (World).rom" size 4 crc 12345678 ) )',
      ),
  );
  const result = await matching.runMatching({ ...input, online: true }, [provider]);
  const art = result.candidates.filter((c) => c.kind === 'artwork');
  assert.ok(art.some((c) => c.url?.endsWith('Game%20(USA).png')));
  assert.ok(art.some((c) => c.url?.endsWith('Game%20(World).png')));
  assert.equal(art.find((c) => c.title === 'Game (USA)')?.confidence, 'name');
  assert.equal(art.find((c) => c.title === 'Game (World)')?.confidence, 'checksum');
});

test('MD5 plus CRC can match CRC-only catalogs without downgrading a conflicting MD5', () => {
  const records: matching.DatRecord[] = [
    { name: 'CRC only.rom', title: 'CRC only', size: 4, crc32: '12345678' },
    { name: 'Conflict.rom', title: 'Conflict', size: 4, crc32: '12345678', md5: 'b'.repeat(32) },
    { name: 'MD5.rom', title: 'MD5', size: 4, crc32: '87654321', md5: 'a'.repeat(32) },
    { name: 'Wrong size.rom', title: 'Wrong size', size: 5, crc32: '12345678' },
  ];
  const renamed = { ...input, name: 'Renamed.rom', md5: 'a'.repeat(32) };
  for (const search of [
    (value: matching.MatchingInput) => matching.matchLibretro(value, records),
    matching.createLibretroMatcher(records),
  ]) {
    assert.deepEqual(
      search(renamed).map((row) => [row.title, row.confidence]),
      [
        ['CRC only', 'checksum'],
        ['MD5', 'checksum'],
      ],
    );
  }
});
