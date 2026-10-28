import assert from 'node:assert/strict';
import test from 'node:test';
import * as matching from '../src/matching.js';
import type { RomFacts } from '../src/rom-facts.js';

function required<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}

const systemId = 'com.provenance.dreamcast';
const sha1 = '1'.repeat(40),
  md5 = '2'.repeat(32);
const facts = (overrides: Partial<RomFacts> = {}): RomFacts => ({
  version: 1,
  pluginIds: ['test.reader'],
  hashes: [],
  identifiers: [],
  names: [],
  warnings: [],
  ...overrides,
});
const input = { name: 'renamed.chd', systemId, companions: [] };
const candidate = (metadata: Record<string, string> = {}): matching.MatchCandidate => ({
  id: 'one',
  kind: 'metadata',
  title: 'Original Game (USA)',
  confidence: 'name',
  metadata: { systemId, ...metadata },
});

test('artwork classification preserves role and edition without guessing generic words', () => {
  assert.deepEqual(matching.classifyArtwork('Original Game (USA) [back].png'), {
    role: 'back',
    baseTitle: 'Original Game (USA)',
    explicit: true,
  });
  assert.deepEqual(matching.classifyArtwork('Named_Boxarts/Original Game (USA).png'), {
    role: 'front',
    baseTitle: 'Original Game (USA)',
    explicit: true,
  });
  assert.equal(matching.classifyArtwork('Original Game.png', 'Named_Titles').role, 'title');
  assert.equal(matching.classifyArtwork('manuals/Original Game (USA).pdf').role, 'manual');
  assert.equal(matching.classifyArtwork('Back to Adventure.png').baseTitle, 'Back to Adventure');
  assert.equal(matching.classifyArtwork('Back to Adventure.png').role, 'front');
});

test('local roles include manual PDFs and normalized verified patch bases', async () => {
  const result = await matching.localMatchingProvider.search({
    ...input,
    name: 'Original Game (USA).rom',
    facts: facts({
      hashes: [
        {
          algorithm: 'crc32',
          value: '12345678',
          size: 16,
          representation: 'nes-prg-chr',
          verified: true,
        },
      ],
    }),
    companions: [
      { id: 'back', name: 'Original Game (USA) back.png' },
      { id: 'manual', name: 'manuals/Original Game (USA).pdf' },
      {
        id: 'patch',
        name: 'original [Translation].bps',
        patch: { format: 'bps', sourceCrc32: '12345678', sourceSize: 16 },
      },
      {
        id: 'bad',
        name: 'Original Game (USA) hack.bps',
        patch: { format: 'bps', sourceCrc32: '87654321', sourceSize: 16 },
      },
    ],
  });
  assert.equal(result.find((c) => c.id === 'manual')?.metadata.artworkRole, 'manual');
  assert.equal(result.find((c) => c.id === 'back')?.metadata.artworkRole, 'back');
  assert.equal(result.find((c) => c.id === 'patch')?.confidence, 'checksum');
  assert.equal(result.find((c) => c.id === 'patch')?.metadata.patchType, 'translation');
  assert.ok(!result.some((c) => c.id === 'bad'));
});

test('partial DAT retains SHA1, serial and size-less disk entries', () => {
  const records = matching.parseLibretroDat(
    `game ( name "Original Game (USA)" serial "T-12345N" rom ( name "track.bin" size 16 sha1 ${sha1} ) disk ( name "disk" sha1 ${md5}11111111 ) )`,
  );
  assert.equal(records.length, 2);
  assert.deepEqual(records[0]?.serials, ['T-12345N']);
  assert.equal(records[0]?.sha1, sha1);
  assert.equal(records[1]?.size, undefined);
  assert.equal(records[1]?.media, 'disk');
});

test('verified extracted/normalized hashes match DAT and compile index parity', () => {
  const request = {
    ...input,
    facts: facts({
      hashes: [
        {
          algorithm: 'sha1' as const,
          value: sha1,
          size: 16,
          representation: '7z-member:original.bin',
          verified: true,
        },
      ],
    }),
  };
  const records: matching.DatRecord[] = [
    { name: 'track.bin', title: 'Original Game (USA)', size: 16, sha1, systemId },
  ];
  const result = matching.matchLibretro(request, records);
  assert.equal(result[0]?.confidence, 'checksum');
  assert.equal(result[0]?.metadata.hashRepresentation, '7z-member:original.bin');
  assert.equal(matching.automaticEvidence(request, required(result[0])), true);
  assert.deepEqual(matching.createLibretroMatcher(records)(request), result);
});

test('declared combined CHD SHA1 is review evidence and raw SHA1 is not disk identity', () => {
  const records: matching.DatRecord[] = [
    { name: 'disk', title: 'Original Game (USA)', sha1, media: 'disk', systemId },
  ];
  const request = {
    ...input,
    facts: facts({
      hashes: [
        {
          algorithm: 'sha1' as const,
          value: sha1,
          size: 123456,
          representation: 'chd-combined-sha1',
          verified: false,
        },
      ],
    }),
  };
  const result = matching.createLibretroMatcher(records)(request);
  assert.equal(result[0]?.metadata.matchEvidence, 'declared-hash');
  assert.equal(result[0]?.confidence, 'name');
  assert.equal(matching.automaticEvidence(request, required(result[0])), false);
  assert.equal(
    matching.matchLibretro(
      {
        ...input,
        facts: facts({
          hashes: [{ ...required(request.facts.hashes[0]), representation: 'chd-raw-sha1' }],
        }),
      },
      records,
    ).length,
    0,
  );
});

test('exact serial can establish identity but declared set IDs remain review', () => {
  const records: matching.DatRecord[] = [
    {
      name: 'orig',
      title: 'Original Game (USA)',
      serials: ['T-12345N'],
      setIds: ['origset'],
      systemId,
    },
  ];
  const request = {
    ...input,
    facts: facts({
      identifiers: [{ type: 'serial', value: 't 12345n', systemId, verified: true }],
    }),
  };
  const result = matching.createLibretroMatcher(records)(request);
  assert.equal(result[0]?.confidence, 'name');
  assert.equal(result[0]?.metadata.matchEvidence, 'verified-serial');
  assert.equal(matching.automaticEvidence(request, required(result[0])), true);
  assert.equal(
    matching.matchLibretro(
      {
        ...input,
        facts: facts({
          identifiers: [{ type: 'serial', value: 'T-12345M', systemId, verified: true }],
        }),
      },
      records,
    ).length,
    0,
  );
  const setRequest = {
    ...input,
    facts: facts({ identifiers: [{ type: 'set', value: 'ORIGSET', systemId, verified: false }] }),
  };
  const setResult = matching.matchLibretro(setRequest, records);
  assert.equal(setResult[0]?.metadata.matchEvidence, 'set-alias');
  assert.equal(matching.automaticEvidence(setRequest, required(setResult[0])), false);
});

test('same-representation stronger hash mismatches cannot be discarded by CRC or serial', () => {
  const request = {
    ...input,
    facts: facts({
      hashes: [
        { algorithm: 'md5', value: md5, size: 16, representation: 'raw', verified: true },
        { algorithm: 'crc32', value: '12345678', size: 16, representation: 'raw', verified: true },
      ],
      identifiers: [{ type: 'serial', value: 'T-12345N', systemId, verified: true }],
    }),
  };
  const result = matching.matchLibretro(request, [
    {
      name: 'a',
      title: 'Original Game (USA)',
      size: 16,
      md5: '3'.repeat(32),
      crc32: '12345678',
      serials: ['T-12345N'],
      systemId,
    },
  ]);
  assert.equal(result[0]?.metadata.matchEvidence, 'hash-conflict');
  assert.equal(result[0]?.confidence, 'name');
  assert.equal(matching.automaticEvidence(request, required(result[0])), false);
  assert.equal(
    matching.automaticEvidence(
      request,
      candidate({ md5: '3'.repeat(32), crc32: '12345678', hashSize: '16', confidence: 'checksum' }),
    ),
    false,
  );
});

test('reconciliation merges compatible catalogs preserving provenance and remains idempotent', () => {
  const a = {
    ...candidate({ crc32: '12345678', hashSize: '16', source: 'A', publisher: 'Original Studio' }),
    providerId: 'test.a',
  };
  const b = {
    ...candidate({ crc32: '12345678', hashSize: '16', source: 'B', genre: 'Test' }),
    id: 'two',
    providerId: 'test.b',
  };
  const result = matching.reconcileCandidates(input, [a, b]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.metadata.publisher, 'Original Studio');
  assert.equal(result[0]?.metadata.genre, 'Test');
  assert.equal(JSON.parse(required(result[0]).metadata.matchProvenance ?? '[]').length, 2);
  assert.deepEqual(matching.reconcileCandidates(input, result), result);
});

test('reconciliation preserves hash, serial, region, revision and distinct artwork conflicts', () => {
  for (const other of [
    candidate({ crc32: '87654321', hashSize: '16' }),
    candidate({ serials: '["T-12345M"]' }),
    { ...candidate(), title: 'Original Game (Japan)' },
    { ...candidate(), title: 'Original Game (USA) (Rev 1)' },
    { ...candidate(), title: 'Original Game (USA) (Proto)' },
  ]) {
    assert.equal(
      matching.reconcileCandidates(input, [
        candidate({ crc32: '12345678', hashSize: '16', serials: '["T-12345N"]' }),
        { ...other, id: 'two' },
      ]).length,
      2,
    );
  }
  const front = {
    ...candidate({ artworkRole: 'front' }),
    kind: 'artwork' as const,
    url: 'https://example.com/front.png',
  };
  assert.equal(
    matching.reconcileCandidates(input, [
      front,
      {
        ...front,
        id: 'back',
        metadata: { artworkRole: 'back' },
        url: 'https://example.com/back.png',
      },
    ]).length,
    2,
  );
  assert.equal(
    matching.automaticEvidence(
      { ...input, md5, size: 16 },
      { ...front, metadata: { md5, hashSize: '16', artworkRole: 'back' } },
    ),
    false,
  );
});

test('verified Dreamcast serial finds one canonical front without inventing an image checksum', async () => {
  const { createLibretroProvider } = await import('../src/libretro-matching.js');
  const provider = createLibretroProvider(
    async (url) =>
      new Response(
        String(url).includes('/git/trees/')
          ? JSON.stringify({
              sha: 'a'.repeat(40),
              truncated: false,
              tree: [
                { path: 'Named_Boxarts/Original Game (USA).png', type: 'blob', size: 1000 },
                { path: 'Named_Titles/Original Game (USA).png', type: 'blob', size: 1000 },
                { path: 'Named_Snaps/Original Game (USA).png', type: 'blob', size: 1000 },
              ],
            })
          : 'game ( name "Original Game (USA)" serial "T-12345N" rom ( name "track.bin" size 2000 ) )',
      ),
  );
  const request = {
    ...input,
    online: true,
    facts: facts({
      identifiers: [{ type: 'serial', value: 'T-12345N', systemId, verified: true }],
    }),
  };
  const result = await provider.search(request);
  assert.equal(result.filter((row) => row.kind === 'artwork').length, 3);
  const cover = required(result.find((row) => row.metadata.artworkRole === 'front'));
  assert.equal(cover.confidence, 'name');
  assert.equal(cover.metadata.matchEvidence, 'verified-serial');
  assert.equal(matching.automaticEvidence(request, cover), true);
  assert.ok(
    result
      .filter((row) => ['title', 'screenshot'].includes(row.metadata.artworkRole ?? ''))
      .every((row) => !matching.automaticEvidence(request, row)),
  );
});

test('declared arcade set aliases resolve canonical art while staying review only', async () => {
  const { createLibretroProvider } = await import('../src/libretro-matching.js');
  const provider = createLibretroProvider(
    async (url) =>
      new Response(
        String(url).includes('/git/trees/')
          ? JSON.stringify({
              sha: 'a'.repeat(40),
              truncated: false,
              tree: [
                { path: 'Named_Boxarts/Original Arcade (Japan).png', type: 'blob', size: 1000 },
              ],
            })
          : String(url).includes('naomi_roms.cpp')
            ? 'const Game Games[] = { { "origset", NULL, "Original Arcade (Japan)", 0x100, 0, "naomi2", GD, ROT0, {}, "gds-0000" }, };'
            : 'clrmamepro ( name "Empty" )',
      ),
  );
  const request = {
    name: 'renamed.zip',
    systemId: 'com.provenance.naomi2',
    online: true,
    companions: [],
    facts: facts({
      identifiers: [
        { type: 'set', value: 'origset', systemId: 'com.provenance.naomi2', verified: false },
      ],
    }),
  };
  const result = await provider.search(request);
  assert.ok(
    result.some((row) => row.kind === 'artwork' && row.title === 'Original Arcade (Japan)'),
  );
  assert.ok(result.every((row) => !matching.automaticEvidence(request, row)));
});

test('large or conflicting provenance cannot be truncated away to reduce conflicts', () => {
  const a = candidate({ source: 'x'.repeat(3900) });
  const b = { ...candidate({ source: 'y'.repeat(3900) }), id: 'two' };
  assert.equal(matching.reconcileCandidates(input, [a, b]).length, 2);
  const rows = matching.reconcileCandidates(input, [
    candidate({ crc32: '12345678', hashSize: '16' }),
    { ...candidate({ crc32: '87654321', hashSize: '32' }), id: 'two' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(required(rows[0]).metadata.matchProvenance ?? '[]').length, 2);
});

test('later reconciliation checks every prior alias and per-file hash instead of only the representative', () => {
  const a = candidate({ crc32: '11111111', hashSize: '16' });
  const b = { ...candidate({ crc32: '22222222', hashSize: '32' }), id: 'two' };
  const c = { ...candidate({ crc32: '33333333', hashSize: '32' }), id: 'three' };
  assert.equal(matching.reconcileCandidates(input, [a, b, c]).length, 2);
  const noRegion = { ...candidate(), title: 'Original Game' };
  assert.equal(
    matching.reconcileCandidates(input, [
      noRegion,
      { ...candidate(), id: 'usa' },
      { ...candidate(), id: 'japan', title: 'Original Game (Japan)' },
    ]).length,
    2,
  );
});

test('declared header evidence cannot override contradictory verified bytes or pretend to be a track hash', () => {
  const request = {
    ...input,
    facts: facts({
      hashes: [
        {
          algorithm: 'sha1',
          value: sha1,
          size: 16,
          representation: 'chd-combined-sha1',
          verified: false,
        },
        {
          algorithm: 'sha1',
          value: '2'.repeat(40),
          size: 16,
          representation: 'raw',
          verified: true,
        },
      ],
      identifiers: [{ type: 'serial', value: 'T-12345N', systemId, verified: true }],
    }),
  };
  assert.equal(
    matching.automaticEvidence(
      request,
      candidate({ sha1, hashSize: '16', serials: '["T-12345N"]' }),
    ),
    false,
  );
});

test('real same-game hash conflicts gate all aliases/covers but unrelated hints do not', () => {
  const request = { ...input, name: 'Original Game (USA).rom', size: 16, md5, crc32: '12345678' };
  const good = candidate({ md5, hashSize: '16' });
  const bad = {
    ...candidate({ md5: '3'.repeat(32), crc32: '12345678', hashSize: '16' }),
    id: 'bad',
  };
  const rows = matching.reconcileCandidates(request, [good, bad]);
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every(
      (row) =>
        row.metadata.identityConflict === 'true' && !matching.automaticEvidence(request, row),
    ),
  );
  assert.equal(matching.hasIdentityConflict(request, rows, good), true);
  assert.equal(
    matching.hasIdentityConflict(request, rows, { ...good, title: 'Unrelated Game' }),
    false,
  );
});

test('checksummed patch auto eligibility rechecks base facts and never merges distinct patch files', async () => {
  const request = {
    ...input,
    facts: facts({
      hashes: [
        {
          algorithm: 'crc32',
          value: '12345678',
          size: 16,
          representation: 'nes-prg-chr',
          verified: true,
        },
      ],
    }),
    companions: [
      {
        id: 'p1',
        name: 'first.bps',
        patch: { format: 'bps' as const, sourceCrc32: '12345678', sourceSize: 16 },
      },
      {
        id: 'p2',
        name: 'second.ups',
        patch: { format: 'ups' as const, sourceCrc32: '12345678', sourceSize: 16 },
      },
    ],
  };
  const patches = await matching.localMatchingProvider.search(request);
  assert.equal(patches.length, 2);
  assert.ok(patches.every((row) => matching.automaticEvidence(request, row)));
  assert.equal(matching.reconcileCandidates(request, patches).length, 2);
  assert.equal(matching.automaticEvidence(input, patches[0] ?? candidate()), false);
});

test('one punctuation-normalized canonical cover is eligible but duplicate aliases are not', async () => {
  const { createLibretroProvider } = await import('../src/libretro-matching.js');
  async function lookup(paths: string[]) {
    return createLibretroProvider(
      async (url) =>
        new Response(
          String(url).includes('/git/trees/')
            ? JSON.stringify({
                sha: 'a'.repeat(40),
                truncated: false,
                tree: paths.map((path) => ({ path, type: 'blob', size: 1000 })),
              })
            : `game ( name "Original: Game (USA)" rom ( name "game.bin" size 16 md5 ${md5} ) )`,
        ),
    ).search({ ...input, name: 'renamed.rom', size: 16, md5, online: true });
  }
  const request = { ...input, size: 16, md5 };
  const single = await lookup(['Named_Boxarts/Original - Game (USA).png']);
  assert.equal(single.find((row) => row.kind === 'artwork')?.confidence, 'checksum');
  assert.equal(
    matching.automaticEvidence(request, required(single.find((row) => row.kind === 'artwork'))),
    true,
  );
  const duplicate = await lookup([
    'Named_Boxarts/Original - Game (USA).png',
    'Named_Boxarts/Original: Game (USA).png',
  ]);
  assert.ok(
    duplicate
      .filter((row) => row.kind === 'artwork')
      .every((row) => !matching.automaticEvidence(request, row)),
  );
});

test('reconciliation carries provider attribution into already-reconciled builtin provenance', async () => {
  const local = matching.reconcileCandidates(input, [
    candidate({ source: 'Catalog A' }),
    { ...candidate({ source: 'Catalog B' }), id: 'two' },
  ]);
  const result = await matching.runMatching(input, [
    {
      id: 'test.one',
      name: 'First',
      capabilities: ['metadata'],
      network: false,
      search: async () => local,
    },
    {
      id: 'test.two',
      name: 'Second',
      capabilities: ['metadata'],
      network: false,
      search: async () => [{ ...candidate({ source: 'Catalog C' }), id: 'three' }],
    },
  ]);
  const provenance = JSON.parse(result.candidates[0]?.metadata.matchProvenance ?? '[]');
  assert.deepEqual(
    provenance.map((row: { providerId: string }) => row.providerId),
    ['test.one', 'test.one', 'test.two'],
  );
});

test('different verified serials or systems retain review candidates instead of selecting the first ID', () => {
  const records: matching.DatRecord[] = [
    { name: 'first', title: 'Original Game (USA)', serials: ['T-12345N'], systemId },
    { name: 'second', title: 'Other Original Game (USA)', serials: ['T-54321N'], systemId },
  ];
  for (const second of [
    { type: 'serial' as const, value: 'T-54321N', systemId, verified: true },
    {
      type: 'serial' as const,
      value: 'GDS-0001',
      systemId: 'com.provenance.naomi',
      verified: true,
    },
    { type: 'serial' as const, value: 'T12345N', systemId: 'com.provenance.naomi', verified: true },
  ]) {
    const request = {
      ...input,
      facts: facts({
        identifiers: [{ type: 'serial', value: 'T-12345N', systemId, verified: true }, second],
      }),
    };
    const originalFacts = structuredClone(request.facts);
    const result = matching.createLibretroMatcher(records)(request);
    assert.ok(result.some((row) => row.title === 'Original Game (USA)'));
    assert.ok(result.every((row) => !matching.automaticEvidence(request, row)));
    assert.equal(
      matching.automaticEvidence(
        { ...request, md5, size: 16 },
        candidate({ md5, hashSize: '16', serials: '["T-12345N"]' }),
      ),
      false,
    );
    assert.deepEqual(request.facts, originalFacts);
  }
});

test('punctuation aliases and unverified serial hints do not create verified-serial conflicts', () => {
  for (const extra of [
    { type: 'serial' as const, value: 't 12345n', systemId, verified: true },
    { type: 'serial' as const, value: 'T-54321N', systemId, verified: false },
    { type: 'set' as const, value: 'different-set', systemId, verified: true },
  ]) {
    const request = {
      ...input,
      facts: facts({
        identifiers: [{ type: 'serial', value: 'T-12345N', systemId, verified: true }, extra],
      }),
    };
    assert.equal(matching.automaticEvidence(request, candidate({ serials: '["T12345N"]' })), true);
  }
});

test('verified GD serial resolves unique catalog-declared serial-suffix front for Naomi and Naomi2', async () => {
  const { createLibretroProvider } = await import('../src/libretro-matching.js');
  for (const [board, bios, serial] of [
    ['com.provenance.naomi', 'naomi', 'GDL-0001'],
    ['com.provenance.naomi2', 'naomi2', 'GDS-0002'],
  ] as const) {
    const search = async (suffixes: string[], verified = true) => {
      const provider = createLibretroProvider(
        async (url) =>
          new Response(
            String(url).includes('/git/trees/')
              ? JSON.stringify({
                  sha: 'a'.repeat(40),
                  truncated: false,
                  tree: suffixes.map((suffix) => ({
                    path: `Named_Boxarts/Original Arcade (${suffix}).png`,
                    type: 'blob',
                    size: 1000,
                  })),
                })
              : String(url).includes('naomi_roms.cpp')
                ? `const Game Games[] = { { "origset", NULL, "Original Arcade", 0x100, 0, "${bios}", GD, ROT0, {}, "${serial.toLowerCase()}" }, };`
                : 'clrmamepro ( name "Empty" )',
          ),
      );
      const request = {
        name: 'renamed.chd',
        systemId: board,
        online: true,
        companions: [],
        facts: facts({
          identifiers: [{ type: 'serial', value: serial, systemId: null, verified }],
        }),
      };
      return { request, rows: await provider.search(request) };
    };
    const { request, rows } = await search([serial]);
    const metadata = required(rows.find((row) => row.kind === 'metadata'));
    const cover = required(rows.find((row) => row.kind === 'artwork'));
    assert.equal(metadata.metadata.matchEvidence, 'verified-serial');
    assert.equal(matching.automaticEvidence(request, metadata), true);
    assert.equal(matching.automaticEvidence(request, cover), true);
    assert.equal(cover.metadata.artworkRole, 'front');
    assert.equal(cover.metadata.matchedGame, 'Original Arcade');
    const wrong = await search(['GDS-9999']);
    assert.ok(
      wrong.rows
        .filter((row) => row.kind === 'artwork')
        .every((row) => !matching.automaticEvidence(wrong.request, row)),
    );
    const declared = await search([serial], false);
    assert.ok(declared.rows.every((row) => !matching.automaticEvidence(declared.request, row)));
    const ambiguous = await search([serial, serial.replace('-', '')]);
    assert.ok(
      ambiguous.rows
        .filter((row) => row.kind === 'artwork')
        .every((row) => !matching.automaticEvidence(ambiguous.request, row)),
    );
  }
});

test('shared verified serial reconciles a Redump subtitle and Flycast short title with canonical suffix art', async () => {
  const { createLibretroProvider } = await import('../src/libretro-matching.js');
  const board = 'com.provenance.naomi2';
  async function search(longTitle = 'Original Volley - Virtual Beach Volleyball (World) (En,Ja)') {
    const provider = createLibretroProvider(
      async (url) =>
        new Response(
          String(url).includes('/git/trees/')
            ? JSON.stringify({
                sha: 'a'.repeat(40),
                truncated: false,
                tree: [
                  {
                    path: 'Named_Boxarts/Original Volley (GDS-0002).png',
                    type: 'blob',
                    size: 1000,
                  },
                ],
              })
            : String(url).includes('naomi_roms.cpp')
              ? 'const Game Games[] = { { "origvol", NULL, "Original Volley", 0x100, 0, "naomi2", GD, ROT0, {}, "gds-0002" }, };'
              : `game ( name "${longTitle}" serial "GDS-0002" rom ( name "Track 3.bin" size 1185760800 crc 12345678 md5 ${md5} sha1 ${sha1} ) )`,
        ),
    );
    const request = {
      name: 'GDS0002.chd',
      systemId: board,
      online: true,
      companions: [],
      facts: facts({
        identifiers: [{ type: 'serial', value: 'GDS-0002', systemId: null, verified: true }],
      }),
    };
    return { request, rows: await provider.search(request) };
  }
  const { request, rows } = await search();
  const metadata = rows.filter((row) => row.kind === 'metadata');
  assert.equal(metadata.length, 1);
  assert.equal(JSON.parse(metadata[0]?.metadata.matchProvenance ?? '[]').length, 2);
  assert.equal(matching.automaticEvidence(request, required(metadata[0])), true);
  const cover = required(rows.find((row) => row.kind === 'artwork'));
  assert.equal(cover.metadata.matchEvidence, 'verified-serial');
  assert.equal(matching.automaticEvidence(request, cover), true);
  for (const title of [
    'Original Volley - Virtual Beach Volleyball (Japan) (Proto)',
    'Original Volley - Virtual Beach Volleyball (World) (Rev 2)',
    'Unrelated Game (World)',
  ]) {
    const other = await search(title);
    assert.equal(other.rows.filter((row) => row.kind === 'metadata').length, 2);
    assert.ok(
      other.rows
        .filter((row) => row.kind === 'artwork')
        .every((row) => !matching.automaticEvidence(other.request, row)),
    );
  }
});
