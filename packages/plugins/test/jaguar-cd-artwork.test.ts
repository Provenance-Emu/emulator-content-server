import assert from 'node:assert/strict';
import test from 'node:test';
import { createLibretroProvider } from '../src/libretro-matching.js';
import { automaticEvidence, type MatchingInput } from '../src/matching.js';

const revision = 'ffea7893a59dd9b9e6f9b85c51627810338b0778';
const prefix = 'site/thumbnails/Atari - Jaguar CD/';
const systemId = 'com.provenance.jaguarcd';
function request(title: string): MatchingInput {
  return {
    name: `${title}.cue`,
    systemId,
    companions: [],
    online: true,
    allowExactNames: true,
    selectedMetadata: { id: 'saved', revision: 3, title, systemId, metadata: { systemId } },
  };
}
function provider(paths: string[], options: { official?: boolean; sha?: string } = {}) {
  const urls: string[] = [];
  return {
    urls,
    client: createLibretroProvider(
      async (url) => {
        const address = String(url);
        urls.push(address);
        if (address.includes('libretro-thumbnails/Atari_-_Jaguar_CD/')) {
          return options.official
            ? new Response(
                JSON.stringify({
                  sha: 'a'.repeat(40),
                  tree: [{ path: paths[0], type: 'blob', size: 100, sha: 'b'.repeat(40) }],
                }),
              )
            : new Response('', { status: 404 });
        }
        if (address.includes('libretro/virtualjaguar-libretro/git/trees/')) {
          return new Response(
            JSON.stringify({
              sha: options.sha ?? revision,
              tree: paths.map((path) => ({
                path: prefix + path,
                type: 'blob',
                size: 100,
                sha: 'b'.repeat(40),
              })),
            }),
          );
        }
        throw new Error('Unexpected public request');
      },
      undefined,
      async () => [],
    ),
  };
}

test('Jaguar CD uses a pinned dedicated mirror and saved identity to fill missing fronts', async () => {
  const title = 'Baldies (USA) (Rev 1)';
  const { client, urls } = provider([`Named_Boxarts/${title}.png`, `Named_Titles/${title}.png`]);
  const input = request(title);
  const results = await client.search(input);
  const front = results.find((row) => row.metadata.artworkRole === 'front');
  assert.ok(front);
  assert.equal(front.metadata.matchEvidence, 'saved-selection');
  assert.equal(automaticEvidence(input, front), true);
  assert.ok(front.url?.includes(`libretro/virtualjaguar-libretro/${revision}/site/thumbnails/`));
  assert.ok(front.metadata.source?.includes('Virtual Jaguar'));
  assert.ok(!urls.some((url) => url.includes('/Atari_-_Jaguar/')));
  assert.ok(
    results.some((row) => row.metadata.artworkRole === 'title' && !automaticEvidence(input, row)),
  );
});

test('audited public release aliases retain the selected release title and original artwork name', async () => {
  for (const [title, original] of [
    ['Frog Feast (USA) (Unl)', 'Frog Feast (USA)'],
    ['Vid Grid (USA) (Alt)', 'Vid Grid (USA)'],
  ] as const) {
    const { client } = provider([`Named_Boxarts/${original}.png`]);
    const input = request(title);
    const front = (await client.search(input)).find((row) => row.title === title);
    assert.ok(front, title);
    assert.equal(front.metadata.artworkCatalogTitle, original);
    assert.equal(automaticEvidence(input, front), true);
  }
});

test('uncertain region and reissue scans remain review-only even with an exact saved identity', async () => {
  for (const title of [
    'Blue Lightning (USA)',
    'Battle Morph (USA) (Songbird)',
    'World Tour Racing (USA) (Songbird)',
  ]) {
    const { client } = provider([`Named_Boxarts/${title}.png`]);
    const input = request(title);
    const front = (await client.search(input)).find((row) => row.kind === 'artwork');
    assert.ok(front);
    assert.equal(front.metadata.artworkReviewRequired, 'true');
    assert.equal(automaticEvidence(input, front), false);
    assert.notEqual(front.metadata.matchEvidence, 'saved-selection');
  }
});

test('a missing release alias never turns an arbitrary edition into an automatic cover', async () => {
  const { client } = provider(['Named_Boxarts/Frog Feast (USA).png']);
  const input = request('Frog Feast (USA) (Demo)');
  assert.ok((await client.search(input)).every((row) => !automaticEvidence(input, row)));
});

test('official dedicated thumbnails take precedence over the mirror', async () => {
  const { client, urls } = provider(['Named_Boxarts/Baldies (USA) (Rev 1).png'], {
    official: true,
  });
  const results = await client.search(request('Baldies (USA) (Rev 1)'));
  assert.ok(results[0]?.url?.includes('libretro-thumbnails/Atari_-_Jaguar_CD/'));
  assert.ok(!urls.some((url) => url.includes('virtualjaguar-libretro')));
});

test('a changed mirror pin fails closed while leaving metadata available', async () => {
  const { client } = provider(['Named_Boxarts/Baldies (USA) (Rev 1).png'], { sha: 'c'.repeat(40) });
  await assert.rejects(
    client.search(request('Baldies (USA) (Rev 1)')),
    /partial|incomplete|failed/i,
  );
});

test('artwork downloads permit only the pinned Jaguar CD mirror subtree', async () => {
  const { isBuiltinArtworkUrl } = await import('../src/matching.js');
  const base = `https://raw.githubusercontent.com/libretro/virtualjaguar-libretro/${revision}/site/thumbnails/Atari%20-%20Jaguar%20CD/`;
  assert.equal(isBuiltinArtworkUrl(`${base}Named_Boxarts/Baldies%20(USA)%20(Rev%201).png`), true);
  for (const url of [
    `${base.replace(revision, 'master')}Named_Boxarts/Baldies.png`,
    `${base.replace(revision, 'a'.repeat(40))}Named_Boxarts/Baldies.png`,
    `${base}../Jaguar/Named_Boxarts/Baldies.png`,
    `${base}Named_Boxarts/%2Fother.png`,
    `${base}Named_Boxarts/Baldies.png?x=1`,
    `${base}Named_Boxarts/Baldies.png#fragment`,
    base.replace('raw.githubusercontent.com', 'raw.githubusercontent.com.attacker.invalid') +
      'Named_Boxarts/Baldies.png',
    `${base.replace('https://', 'https://user@')}Named_Boxarts/Baldies.png`,
    `${base}SOURCES.tsv`,
    `${base}Named_Boxarts/Baldies.txt`,
  ])
    assert.equal(isBuiltinArtworkUrl(url), false, url);
});
