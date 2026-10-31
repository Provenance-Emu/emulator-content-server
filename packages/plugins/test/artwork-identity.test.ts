import assert from 'node:assert/strict';
import test from 'node:test';
import { createLibretroProvider, LIBRETRO_SYSTEMS } from '../src/libretro-matching.js';
import { automaticEvidence, type MatchingInput } from '../src/matching.js';
import { artworkTitleMatches } from '../src/matching-names.js';

test('saved artwork identity tolerates catalog formatting while retaining release facts', () => {
  for (const [left, right, ids] of [
    ['Orbit Rally (USA) (En,Fr)', 'Orbit Rally (US)', []],
    ['Orbit Rally (Rev A)', 'Orbit Rally (Japan, Rev A)', []],
    ['Orbit Rally', 'Orbit Rally (Japan) (GDL-1234)', ['GDL-1234']],
    ['Orbit Rally / Space Race', 'Orbit Rally ~ Space Race', []],
  ] as const)
    assert.equal(artworkTitleMatches(left, right, ids), true, `${left} → ${right}`);
  for (const [left, right, ids] of [
    ['Orbit Rally (USA)', 'Orbit Rally (Japan)', []],
    ['Orbit Rally (USA) (En)', 'Orbit Rally (USA) (Ja)', []],
    ['Orbit Rally', 'Orbit Rally (Rev A)', []],
    ['Orbit Rally (Rev A)', 'Orbit Rally (Japan, Rev B)', []],
    ['Orbit Rally', 'Orbit Rally (Japan) (GDL-1234)', ['GDL-9999']],
    ['Orbit Rally (Disc 1)', 'Orbit Rally (Disc 2)', []],
    ['Orbit Rally', 'Orbit Rally (Songbird)', []],
    ['Orbit Rally', 'Orbit Rally (Demo)', []],
    ['Orbit Rally', 'Orbit Rally (Alt)', []],
    ['Orbit Rally', 'Orbit Rally (constructor)', []],
    ['Orbit Rally', 'Orbit Rally (Translation)', []],
    ['Orbit Rally / Space Race', 'Orbit Rally / Another Game', []],
    ['Orbit Rally / Space Race', 'Orbit Rally', []],
  ] as const)
    assert.equal(artworkTitleMatches(left, right, ids), false, `${left} → ${right}`);
});

test('provider and automatic evidence agree on the saved catalog identity and declared serial', async () => {
  const title = 'Orbit Rally (Rev A)',
    systemId = 'com.provenance.naomi';
  const provider = createLibretroProvider(
    async () =>
      new Response(
        JSON.stringify({
          sha: 'a'.repeat(40),
          tree: [
            {
              path: 'Named_Boxarts/Orbit Rally (Japan, Rev A) (GDL-1234).png',
              type: 'blob',
              size: 1000,
              sha: 'b'.repeat(40),
            },
          ],
        }),
      ),
    undefined,
    async () => [],
  );
  const input: MatchingInput = {
    name: 'renamed.zip',
    systemId,
    online: true,
    companions: [],
    selectedMetadata: {
      id: 'saved',
      revision: 2,
      title,
      systemId,
      metadata: { systemId, serials: '["GDL-1234"]' },
    },
  };
  const front = (await provider.search(input)).find((c) => c.metadata.artworkRole === 'front');
  assert.ok(front);
  assert.equal(front.metadata.matchEvidence, 'saved-selection');
  assert.equal(automaticEvidence(input, front), true);
  assert.ok(input.selectedMetadata);
  const other = {
    ...input,
    selectedMetadata: {
      ...input.selectedMetadata,
      metadata: { systemId, serials: '["GDL-9999"]' },
    },
  };
  assert.equal(automaticEvidence(other, front), false);
});

test('distinct regional scans for an unspecified saved title stay reviewable', async () => {
  const systemId = 'com.provenance.naomi',
    title = 'Orbit Rally';
  const p = createLibretroProvider(
    async () =>
      new Response(
        JSON.stringify({
          sha: 'a'.repeat(40),
          tree: ['USA', 'Japan'].map((region, i) => ({
            path: `Named_Boxarts/${title} (${region}).png`,
            type: 'blob',
            size: 1000,
            sha: String(i + 1).repeat(40),
          })),
        }),
      ),
    undefined,
    async () => [],
  );
  const input: MatchingInput = {
    name: 'renamed.zip',
    systemId,
    online: true,
    companions: [],
    selectedMetadata: { id: 'saved', revision: 2, title, systemId, metadata: { systemId } },
  };
  assert.ok((await p.search(input)).every((c) => !automaticEvidence(input, c)));
});

test('artwork catalog covers requested Provenance console and arcade system identifiers', () => {
  for (const id of [
    '2600',
    '5200',
    '7800',
    'gb',
    'gbc',
    'gba',
    'nes',
    'snes',
    'gamegear',
    'vb',
    'gamecube',
    'wii',
    'jaguar',
    'jaguarcd',
    'dreamcast',
    'naomi',
    'naomi2',
    'atomiswave',
    'psx',
    'ps2',
    'pce',
    'pcecd',
    'pcfx',
    'lynx',
    'ngp',
    'ngpc',
    'ws',
    'wsc',
    'mame',
    '32X',
    'segacd',
  ])
    assert.ok(LIBRETRO_SYSTEMS[`com.provenance.${id}`], id);
});

test('new handheld and Atari file extensions find their own system artwork repository', async () => {
  for (const [id, extension, repo] of [
    ['2600', 'a26', 'Atari_-_2600'],
    ['5200', 'a52', 'Atari_-_5200'],
    ['7800', 'a78', 'Atari_-_7800'],
    ['vb', 'vb', 'Nintendo_-_Virtual_Boy'],
    ['pce', 'pce', 'NEC_-_PC_Engine_-_TurboGrafx_16'],
    ['ws', 'ws', 'Bandai_-_WonderSwan'],
    ['wsc', 'wsc', 'Bandai_-_WonderSwan_Color'],
    ['ngp', 'ngp', 'SNK_-_Neo_Geo_Pocket'],
    ['lynx', 'lnx', 'Atari_-_Lynx'],
  ] as const) {
    const urls: string[] = [];
    const p = createLibretroProvider(
      async (url) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify({
            sha: 'a'.repeat(40),
            tree: [{ path: 'Named_Boxarts/Orbit Rally (World).png', type: 'blob', size: 1000 }],
          }),
        );
      },
      undefined,
      async () => [],
    );
    const input: MatchingInput = {
      name: `Orbit Rally (World).${extension}`,
      systemId: `com.provenance.${id}`,
      online: true,
      allowExactNames: true,
      companions: [],
    };
    const result = await p.search(input);
    assert.ok(
      urls.some((url) => url.includes(`libretro-thumbnails/${repo}/`)),
      id,
    );
    assert.equal(result.filter((c) => automaticEvidence(input, c)).length, 1, id);
  }
});

test('an exact saved cover is preferred over additional compatible formatting variants', async () => {
  const title = 'Orbit Rally (USA)',
    systemId = 'com.provenance.naomi';
  const p = createLibretroProvider(
    async () =>
      new Response(
        JSON.stringify({
          sha: 'a'.repeat(40),
          tree: [title, 'Orbit Rally'].map((name, i) => ({
            path: `Named_Boxarts/${name}.png`,
            type: 'blob',
            size: 1000,
            sha: String(i + 1).repeat(40),
          })),
        }),
      ),
    undefined,
    async () => [],
  );
  const input: MatchingInput = {
    name: 'renamed.zip',
    systemId,
    online: true,
    companions: [],
    selectedMetadata: { id: 'saved', revision: 2, title, systemId, metadata: { systemId } },
  };
  const automatic = (await p.search(input)).filter((c) => automaticEvidence(input, c));
  assert.equal(automatic.length, 1);
  assert.equal(automatic[0]?.title, title);
});
