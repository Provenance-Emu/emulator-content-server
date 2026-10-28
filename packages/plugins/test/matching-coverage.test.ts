import assert from 'node:assert/strict';
import test from 'node:test';
import { createLibretroProvider } from '../src/libretro-matching.js';
import { matchLibretro, parseLibretroDat } from '../src/matching.js';

const dat = `game ( name "Orbit Rally (World)" rom ( name "Orbit Rally (World).j64" size 4 crc 12345678 ) )
game ( name "Orbit Rally (World)" rom ( name "Orbit Rally (World).rom" size 8 crc 87654321 ) )
game ( name "Orbit Rally (Japan) (Beta)" rom ( name "Orbit Rally (Japan) (Beta).j64" size 4 crc 11111111 ) )
game ( name "Orbit Rally (USA) (En,Ja)" rom ( name "Orbit Rally (USA) (En,Ja) (Track 3).bin" size 100 crc 22222222 ) )`;

test('legacy year and release-tag names find one suggestion per edition without claiming verification', () => {
  const records = parseLibretroDat(dat);
  const result = matchLibretro(
    { name: 'Orbit Rally (1995).jag', systemId: 'com.provenance.jaguar', companions: [] },
    records,
  );
  assert.ok(result.some((r) => r.title === 'Orbit Rally (World)'));
  assert.equal(result.filter((r) => r.title === 'Orbit Rally (World)').length, 1);
  assert.ok(result.every((r) => r.confidence === 'name' && !r.title.includes('Beta')));
  const scene = matchLibretro(
    { name: 'Orbit Rally (USA)[RDC].cdi', systemId: 'com.provenance.dreamcast', companions: [] },
    records,
  );
  assert.ok(scene.some((r) => r.title === 'Orbit Rally (USA) (En,Ja)'));
  assert.ok(scene.every((r) => !r.title.includes('Japan')));
});

test('explicit different regions, revisions and prototype dates are not merged', () => {
  const records =
    parseLibretroDat(`game ( name "Orbit Rally (Japan) (Rev 2)" rom ( name "Orbit Rally (Japan) (Rev 2).bin" size 4 ) )
  game ( name "Orbit Rally (World) (Beta) (1993-08-18)" rom ( name "Orbit Rally (World) (Beta) (1993-08-18).j64" size 4 ) )`);
  for (const name of [
    'Orbit Rally (USA) (Rev 2).chd',
    'Orbit Rally (Japan) (Rev 1).chd',
    'Orbit Rally (World) (Beta) (1993-10-13).jag',
  ])
    assert.equal(
      matchLibretro({ name, systemId: 'com.provenance.jaguar', companions: [] }, records).length,
      0,
      name,
    );
});

const sha = 'a'.repeat(40);
function tree(paths: string[]) {
  return JSON.stringify({
    sha,
    truncated: false,
    tree: paths.map((path) => ({ path, type: 'blob', size: 1000 })),
  });
}

test('artwork uses an existing indexed file independently of a metadata hit and skips placeholders', async () => {
  const urls: string[] = [];
  const provider = createLibretroProvider(async (url) => {
    urls.push(String(url));
    return new Response(
      String(url).includes('/git/trees/')
        ? JSON.stringify({
            sha,
            truncated: false,
            tree: [
              {
                path: 'Named_Boxarts/Homebrew Quest (1995)(Publisher).png',
                type: 'blob',
                size: 800,
              },
              { path: 'Named_Boxarts/Homebrew Quest (World).png', type: 'blob', size: 17 },
              { path: 'Named_Snaps/Homebrew Quest (World).png', type: 'blob', size: 600 },
            ],
          })
        : 'clrmamepro ( name "Empty metadata" )',
    );
  });
  const result = await provider.search({
    name: 'Homebrew Quest (1995).jag',
    systemId: 'com.provenance.jaguar',
    companions: [],
    online: true,
  });
  const artwork = result.filter((r) => r.kind === 'artwork');
  assert.ok(artwork.length > 0);
  assert.ok(artwork.every((r) => r.confidence === 'name' && r.url?.includes(`/${sha}/`)));
  assert.ok(!artwork.some((r) => r.url?.includes('Named_Boxarts/Homebrew%20Quest%20(World).png')));
  assert.ok(urls.some((url) => url.includes('/git/trees/')));
});

test('arcade set IDs and disc serials resolve through board-specific Flycast metadata and real artwork branches', async () => {
  const source = `const Game Games[] = {
    { "samplearc", nullptr, "Arcade Orbit (USA)", 0x4000, 0, "naomi", M1, ROT0, { { "part.bin", 0, 4, 0x12345678 } } },
    { "sampletwo", nullptr, "Beach Orbit", 0x4000, 0, "naomi2", GD, ROT0, { { "key.pic", 0, 4, 0 } }, "gds-9999", &sample_inputs },
    { "sampleaw", nullptr, "Atom Orbit", 0x4000, 0, "awbios", AW, ROT0, {} }
  };`;
  const provider = createLibretroProvider(
    async (url) =>
      new Response(
        String(url).includes('naomi_roms.cpp')
          ? source
          : String(url).includes('/git/trees/')
            ? tree([
                'Named_Boxarts/Arcade Orbit (USA).png',
                'Named_Boxarts/Beach Orbit (GDS-9999).png',
                'Named_Boxarts/Atom Orbit.png',
              ])
            : 'clrmamepro ( name "Empty" )',
      ),
  );
  for (const [name, systemId, title] of [
    ['samplearc.zip', 'com.provenance.naomi', 'Arcade Orbit (USA)'],
    ['sampletwo-2.zip', 'com.provenance.naomi2', 'Beach Orbit'],
    ['gds-9999.chd', 'com.provenance.naomi2', 'Beach Orbit'],
    ['sampleaw.zip', 'com.provenance.atomiswave', 'Atom Orbit'],
  ] as const) {
    const results = await provider.search({
      name,
      systemId,
      companions: [],
      online: true,
    });
    assert.equal(results.find((r) => r.kind === 'metadata')?.title, title, name);
    assert.ok(
      results.some((r) => r.kind === 'artwork'),
      name,
    );
    assert.ok(results.every((r) => r.confidence === 'name'));
    assert.ok(
      results
        .filter((r) => r.kind === 'artwork' && systemId === 'com.provenance.naomi2')
        .every((r) => r.url?.includes('Sega_-_Naomi_2/')),
    );
  }
  assert.equal(
    (
      await provider.search({
        name: 'samplearc.zip',
        systemId: 'com.provenance.naomi2',
        companions: [],
        online: true,
      })
    ).filter((r) => r.kind === 'metadata').length,
    0,
  );
});

test('a failed artwork index preserves healthy metadata and reports a retryable provider problem', async () => {
  const { runMatching } = await import('../src/matching.js');
  const provider = createLibretroProvider(async (url) =>
    String(url).includes('/git/trees/')
      ? new Response('unavailable', { status: 503 })
      : new Response(dat),
  );
  const result = await runMatching(
    {
      name: 'Orbit Rally (1995).jag',
      systemId: 'com.provenance.jaguar',
      companions: [],
      online: true,
    },
    [provider],
  );
  assert.ok(result.candidates.some((c) => c.kind === 'metadata'));
  assert.deepEqual(result.problems, [{ providerId: 'org.ecs.libretro', code: 'provider-failed' }]);
});

test('supplemental legacy and arcade catalogs add PD titles and alternate set names', async () => {
  const provider = createLibretroProvider(
    async (url) =>
      new Response(
        String(url).includes('/tosec/')
          ? 'game ( name "Legacy Painter (PD)" rom ( name "Legacy Painter.rom" size 4 crc 12345678 ) )'
          : String(url).includes('/dat/Atomiswave.dat')
            ? 'game ( id "samplealias" name "Samurai Orbit" rom ( name "part.bin" size 4 crc 12345678 ) )'
            : String(url).includes('naomi_roms.cpp')
              ? 'const Game Games[] = { { "sampleaw", nullptr, "Atom Orbit", 0, 0, "awbios", AW, ROT0, {} } };'
              : String(url).includes('/git/trees/')
                ? tree([])
                : 'clrmamepro ( name "Empty" )',
      ),
  );
  const legacy = await provider.search({
    name: 'Legacy Painter (1999) (PD).jag',
    systemId: 'com.provenance.jaguar',
    companions: [],
    online: true,
  });
  assert.equal(legacy.find((c) => c.kind === 'metadata')?.title, 'Legacy Painter (PD)');
  const arcade = await provider.search({
    name: 'samplealias.zip',
    systemId: 'com.provenance.atomiswave',
    companions: [],
    online: true,
  });
  assert.equal(arcade.find((c) => c.kind === 'metadata')?.title, 'Samurai Orbit');
});

test('leading and trailing articles match consistently after release tags', () => {
  const records = parseLibretroDat(
    'game ( name "Orbit Rally, The (World)" rom ( name "Orbit Rally, The (World).rom" size 4 ) )',
  );
  assert.equal(
    matchLibretro(
      { name: 'The Orbit Rally (1995).jag', systemId: 'com.provenance.jaguar', companions: [] },
      records,
    )[0]?.title,
    'Orbit Rally, The (World)',
  );
});

test('available box art is presented before a more exactly named screenshot', async () => {
  const provider = createLibretroProvider(
    async (url) =>
      new Response(
        String(url).includes('/git/trees/')
          ? tree([
              'Named_Snaps/Homebrew Quest (1995).png',
              'Named_Boxarts/Homebrew Quest (World).png',
            ])
          : 'clrmamepro ( name "Empty" )',
      ),
  );
  const result = await provider.search({
    name: 'Homebrew Quest (1995).jag',
    systemId: 'com.provenance.jaguar',
    companions: [],
    online: true,
  });
  assert.equal(result.find((c) => c.kind === 'artwork')?.metadata.artworkType, 'boxarts');
});

test('unknown source systems can be identified only by an unambiguous arcade catalog entry', async () => {
  const source =
    'const Game Games[] = { { "samplearc", nullptr, "Orbit Arcade", 0, 0, "naomi", M1, ROT0, {} }, { "sampletwo", nullptr, "Shared Title", 0, 0, "naomi2", GD, ROT0, {} }, { "sampleaw", nullptr, "Shared Title", 0, 0, "awbios", AW, ROT0, {} } };';
  const provider = createLibretroProvider(
    async (url) =>
      new Response(
        String(url).includes('naomi_roms.cpp')
          ? source
          : String(url).includes('/git/trees/')
            ? tree(['Named_Boxarts/Orbit Arcade.png'])
            : 'clrmamepro ( name "Empty" )',
      ),
  );
  const found = await provider.search({
    name: 'Orbit Arcade (World).7z',
    systemId: null,
    companions: [],
    online: true,
  });
  assert.equal(found.find((c) => c.kind === 'metadata')?.metadata.systemId, 'com.provenance.naomi');
  assert.ok(found.some((c) => c.kind === 'artwork'));
  const ambiguous = await provider.search({
    name: 'Shared Title.7z',
    systemId: null,
    companions: [],
    online: true,
  });
  assert.equal(ambiguous.filter((c) => c.kind === 'metadata').length, 2);
  assert.equal(ambiguous.filter((c) => c.kind === 'artwork').length, 0);
  assert.ok(ambiguous.every((c) => c.confidence === 'name'));
});

test('alternate localized titles match without losing region guards', () => {
  const records = parseLibretroDat(
    'game ( name "Orbit Athlete / Orbit Athletics (USA)" rom ( name "Orbit Athlete (USA).rom" size 4 ) )',
  );
  const input = {
    name: 'Orbit Athletics ~ Orbit Athlete (USA).7z',
    systemId: 'com.provenance.naomi',
    companions: [],
  };
  assert.equal(matchLibretro(input, records).length, 1);
  assert.equal(matchLibretro({ ...input, name: 'Orbit Athletics (Japan).7z' }, records).length, 0);
});

test('warm provider reuses the parsed artwork index for subsequent ROMs', async () => {
  const index = JSON.stringify({
    sha: 'a'.repeat(40),
    truncated: false,
    tree: [{ path: 'Named_Boxarts/Orbit Rally.png', type: 'blob', size: 100 }],
  });
  let parses = 0,
    requests = 0;
  const original = JSON.parse;
  JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) => {
    if (text === index) parses++;
    return original(text, reviver);
  }) as typeof JSON.parse;
  try {
    const provider = createLibretroProvider(async (url) => {
      requests++;
      return new Response(String(url).includes('/git/trees/') ? index : dat);
    });
    const input = {
      name: 'Orbit Rally.jag',
      systemId: 'com.provenance.jaguar',
      companions: [],
      online: true,
    };
    const a = await provider.search(input),
      b = await provider.search(input);
    assert.deepEqual(a, b);
    assert.equal(parses, 1, 'Parsed index should survive the next ROM lookup');
    assert.equal(requests, 3, 'Fresh public catalog bodies should stay in memory');
  } finally {
    JSON.parse = original;
  }
});

test('compiled catalog matcher preserves linear evidence, edition guards and candidate IDs', async () => {
  const { createLibretroMatcher } = await import('../src/matching.js');
  const records = [
    ...parseLibretroDat(dat),
    {
      title: 'Arcade Orbit',
      name: 'sample-set',
      aliases: ['gds-9999'],
      size: 0,
      systemId: 'com.provenance.naomi',
    },
  ];
  const match = createLibretroMatcher(records);
  for (const input of [
    ...[
      'Orbit Rally.jag',
      'Orbit Rally (Japan) (Beta).jag',
      'Orbit Rally (EU).jag',
      'gds-9999-2.chd',
      'unknown.rom',
    ].map((name) => ({ name, systemId: 'com.provenance.jaguar', companions: [] })),
    {
      name: 'renamed.rom',
      systemId: 'com.provenance.jaguar',
      companions: [],
      size: 4,
      crc32: '12345678',
    },
    {
      name: 'renamed.rom',
      systemId: 'com.provenance.jaguar',
      companions: [],
      size: 4,
      crc32: '12345678',
      md5: '0'.repeat(32),
    },
  ])
    assert.deepEqual(match(input), matchLibretro(input, records));
});

test('compiled matcher does not rescan an unrelated 10000-record catalog per ROM', async () => {
  const { createLibretroMatcher } = await import('../src/matching.js');
  let reads = 0;
  const records = Array.from({ length: 10000 }, (_, index) => ({
    title: `Game ${index}`,
    get name() {
      reads++;
      return `Game ${index}.rom`;
    },
    size: 4,
    crc32: index === 4321 ? '12345678' : '87654321',
  }));
  const match = createLibretroMatcher(records);
  reads = 0;
  const result = match({
    name: 'renamed.rom',
    systemId: 'com.provenance.nes',
    companions: [],
    size: 4,
    crc32: '12345678',
  });
  assert.equal(result[0]?.id, 'dat-4321');
  assert.equal(result[0]?.confidence, 'checksum');
  assert.ok(reads < 30, `Unrelated records were rescanned: ${reads}`);
});

test('parsed provider cache evicts old datasets while retained catalogs stay warm', async () => {
  const index = tree(['Named_Boxarts/Orbit Rally (World).png']);
  let parses = 0,
    requests = 0;
  const original = JSON.parse;
  JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) => {
    if (text === index) parses++;
    return original(text, reviver);
  }) as typeof JSON.parse;
  try {
    const provider = createLibretroProvider(async (url) => {
      requests++;
      return new Response(String(url).includes('/git/trees/') ? index : dat);
    });
    const input = {
      name: 'Orbit Rally.rom',
      systemId: 'com.provenance.nes',
      companions: [],
      online: true,
    };
    for (const systemId of [
      'com.provenance.nes',
      'com.provenance.snes',
      'com.provenance.gb',
      'com.provenance.gbc',
      'com.provenance.gba',
    ])
      await provider.search({ ...input, systemId });
    const before = parses;
    await provider.search({ ...input, systemId: 'com.provenance.gba' });
    assert.equal(parses, before);
    await provider.search(input);
    assert.equal(parses, before + 1);
    assert.equal(
      requests,
      10,
      'Dataset eviction should reuse fresh catalog bodies without network/stat reload',
    );
  } finally {
    JSON.parse = original;
  }
});

test('catalog refresh replaces parsed records and artwork rather than retaining stale identities', async () => {
  let title = 'Orbit Rally (World)';
  const provider = createLibretroProvider(
    async (url) =>
      new Response(
        String(url).includes('/git/trees/')
          ? tree([`Named_Boxarts/${title}.png`])
          : `game ( name "${title}" rom ( name "test.rom" size 4 crc 12345678 ) )`,
      ),
  );
  const input = {
    name: 'renamed.rom',
    systemId: 'com.provenance.nes',
    companions: [],
    online: true,
    size: 4,
    crc32: '12345678',
  };
  assert.equal((await provider.search(input)).find((c) => c.kind === 'metadata')?.title, title);
  const now = Date.now;
  title = 'A New Identity (World)';
  try {
    const time = now();
    Date.now = () => time + 6 * 60 * 60 * 1000 + 1;
    assert.equal((await provider.search(input)).find((c) => c.kind === 'metadata')?.title, title);
  } finally {
    Date.now = now;
  }
});

const canonicalDat =
  'game ( name "Orbit Rally (World)" rom ( name "original.rom" size 4 crc 12345678 ) )';
async function covers(paths: string[], catalog = canonicalDat, checksum = true) {
  const provider = createLibretroProvider(
    async (url) => new Response(String(url).includes('/git/trees/') ? tree(paths) : catalog),
  );
  return provider.search({
    name: checksum ? 'renamed.rom' : 'Orbit Rally (World).rom',
    systemId: 'com.provenance.nes',
    companions: [],
    online: true,
    ...(checksum ? { size: 4, crc32: '12345678' } : {}),
  });
}

test('renamed checksum-verified ROM corroborates exactly one canonical box art identity', async () => {
  const result = await covers([
    'Named_Boxarts/Orbit Rally (World).png',
    'Named_Snaps/Orbit Rally (World).png',
  ]);
  const cover = result.find((c) => c.metadata.artworkType === 'boxarts');
  assert.equal(cover?.confidence, 'checksum');
  assert.equal(cover?.metadata.matchedGame, 'Orbit Rally (World)');
  assert.equal(cover?.metadata.systemId, 'com.provenance.nes');
  assert.match(cover?.metadata.verification ?? '', /image checksum not compared/);
  assert.ok(
    result
      .filter((c) => c.metadata.artworkType !== 'boxarts' && c.kind === 'artwork')
      .every((c) => c.confidence === 'name'),
  );
});

test('ambiguous checksum titles never corroborate a cover', async () => {
  const result = await covers(
    ['Named_Boxarts/Orbit Rally (World).png'],
    canonicalDat +
      '\ngame ( name "Another Identity" rom ( name "other.rom" size 4 crc 12345678 ) )',
  );
  assert.ok(result.some((c) => c.kind === 'artwork'));
  assert.ok(result.filter((c) => c.kind === 'artwork').every((c) => c.confidence === 'name'));
});

test('duplicate canonical covers, title/snap-only indexes, and revision differences stay name hints', async () => {
  for (const paths of [
    ['Named_Boxarts/Orbit Rally (World).png', 'Named_Boxarts/ORBIT RALLY (WORLD).png'],
    ['Named_Titles/Orbit Rally (World).png', 'Named_Snaps/Orbit Rally (World).png'],
    ['Named_Boxarts/Orbit Rally (World) (Rev 1).png'],
  ]) {
    const result = await covers(paths);
    assert.ok(result.some((c) => c.kind === 'artwork'));
    assert.ok(result.filter((c) => c.kind === 'artwork').every((c) => c.confidence === 'name'));
  }
});

test('filename-only matches cannot corroborate a canonical cover', async () => {
  const result = await covers(['Named_Boxarts/Orbit Rally (World).png'], canonicalDat, false);
  assert.ok(result.some((c) => c.kind === 'artwork'));
  assert.ok(result.every((c) => c.confidence === 'name'));
});

test('partial provider failures preserve canonical cover as a name hint', async () => {
  const { runMatching } = await import('../src/matching.js');
  const provider = createLibretroProvider(async (url) =>
    String(url).includes('/tosec/')
      ? new Response('unavailable', { status: 503 })
      : new Response(
          String(url).includes('/git/trees/')
            ? tree(['Named_Boxarts/Orbit Rally (World).png'])
            : canonicalDat,
        ),
  );
  const result = await runMatching(
    {
      name: 'renamed.rom',
      systemId: 'com.provenance.jaguar',
      companions: [],
      online: true,
      size: 4,
      crc32: '12345678',
    },
    [provider],
  );
  assert.ok(result.problems.length);
  assert.ok(result.candidates.some((c) => c.kind === 'artwork'));
  assert.ok(
    result.candidates.filter((c) => c.kind === 'artwork').every((c) => c.confidence === 'name'),
  );
});

test('an exact checksum-identified cover is independent of other regional name hints', async () => {
  const result = await covers([
    'Named_Boxarts/Orbit Rally (World).png',
    'Named_Boxarts/Orbit Rally (USA).png',
    'Named_Boxarts/Orbit Rally (World) (Rev 1).png',
    'Named_Snaps/Orbit Rally (World).png',
  ]);
  const verified = result.filter(
    (candidate) => candidate.kind === 'artwork' && candidate.confidence === 'checksum',
  );
  assert.equal(verified.length, 1);
  assert.equal(verified[0]?.title, 'Orbit Rally (World)');
  assert.ok(
    result
      .filter(
        (candidate) => candidate.kind === 'artwork' && candidate.title !== 'Orbit Rally (World)',
      )
      .every((candidate) => candidate.confidence === 'name'),
  );
});
