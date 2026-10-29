import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createHostedCatalog,
  type HostedCatalogIndex,
  type HostedCatalogPin,
  type HostedCatalogRecord,
  validateHostedCatalogIndex,
  validateHostedCatalogShard,
} from '../src/hosted-catalog.js';

function required<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}

const base = 'https://github.com/example/catalog/releases/download/v1/';
const systemId = 'com.provenance.nes';
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
function fixture(
  kind: 'metadata' | 'cheats' | 'patch' = 'metadata',
  extra: Partial<HostedCatalogRecord> = {},
) {
  const resource = Buffer.from('cheats = "1"\ncheat0_code = "0000:01"\ncheat0_enable = "true"\n');
  const record: HostedCatalogRecord = {
    id: 'original',
    title: 'Original Game (USA)',
    name: 'Original Game (USA).nes',
    size: 16,
    crc32: '12345678',
    sourceIds: ['original'],
    ...(kind === 'metadata'
      ? {}
      : {
          resource: {
            url: `${base}original.${kind === 'cheats' ? 'cht' : 'bps'}`,
            sha256: digest(resource),
            bytes: resource.length,
            format: kind === 'cheats' ? ('retroarch-cht' as const) : ('bps' as const),
          },
        }),
    ...extra,
  };
  const shard = encode({ version: 1, release: 'v1', kind, systemId, records: [record] });
  const index: HostedCatalogIndex = {
    version: 1,
    release: 'v1',
    sources: [
      {
        id: 'original',
        name: 'Original generated test facts',
        url: 'https://github.com/example/catalog',
        revision: 'a'.repeat(40),
        license: 'CC0-1.0',
        notice: 'Original generated fixture; no commercial content',
      },
    ],
    shards: [
      {
        id: `nes-${kind}`,
        kind,
        systemId,
        url: `${base}nes-${kind}.json`,
        sha256: digest(shard),
        bytes: shard.length,
        records: 1,
        sourceIds: ['original'],
      },
    ],
  };
  const indexBytes = encode(index);
  const pin: HostedCatalogPin = {
    url: `${base}index.json`,
    sha256: digest(indexBytes),
    bytes: indexBytes.length,
    release: 'v1',
  };
  const bodies = new Map([
    [pin.url, indexBytes],
    [index.shards[0]?.url ?? '', shard],
    [record.resource?.url ?? '', resource],
  ]);
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const bytes = bodies.get(url);
    return new Response(bytes ?? null, { status: bytes ? 200 : 404 });
  };
  return { record, resource, index, shard, pin, bodies, calls, fetcher };
}

test('hosted validators retain declared provenance and reject unknown source or cross-system records', () => {
  const f = fixture();
  assert.deepEqual(validateHostedCatalogIndex(f.index), f.index);
  assert.equal(
    validateHostedCatalogShard(JSON.parse(f.shard.toString()), required(f.index.shards[0]), f.index)
      .records[0]?.id,
    'original',
  );
  assert.throws(() =>
    validateHostedCatalogIndex({
      ...f.index,
      shards: [{ ...f.index.shards[0], sourceIds: ['missing'] }],
    }),
  );
  assert.throws(() =>
    validateHostedCatalogShard(
      {
        version: 1,
        release: 'v1',
        kind: 'metadata',
        systemId,
        records: [{ ...f.record, systemId: 'com.provenance.naomi' }],
      },
      required(f.index.shards[0]),
      f.index,
    ),
  );
});

test('hosted sync verifies pinned index/shard hashes and warm providers reuse their parsed index', async () => {
  const f = fixture();
  const catalog = createHostedCatalog({ pin: f.pin, fetcher: f.fetcher });
  assert.deepEqual(await catalog.sync(), { release: 'v1', shards: 1, records: 1 });
  const provider = required(catalog.providers()[0]);
  const rows = await provider.search({
    name: 'renamed.nes',
    systemId,
    size: 16,
    crc32: '12345678',
    online: true,
    companions: [],
  });
  assert.equal(rows[0]?.confidence, 'checksum');
  assert.equal(rows[0]?.metadata.catalogRelease, 'v1');
  await provider.search({
    name: 'another.nes',
    systemId,
    size: 16,
    crc32: '12345678',
    online: true,
    companions: [],
  });
  assert.equal(f.calls.length, 2);
  assert.ok(
    f.calls.every((call) => call.init?.redirect === 'manual' && call.init.credentials === 'omit'),
  );
});

function repin(f: ReturnType<typeof fixture>, index = f.index) {
  const bytes = encode(index);
  f.bodies.set(f.pin.url, bytes);
  f.pin = { ...f.pin, sha256: digest(bytes), bytes: bytes.length };
}

test('only immutable HTTPS GitHub assets/raw commits are accepted, with required license provenance', () => {
  const f = fixture();
  for (const url of [
    'http://github.com/example/catalog/releases/download/v1/index.json',
    'https://127.0.0.1/index.json',
    'https://user:password@github.com/example/catalog/releases/download/v1/index.json',
    'https://github.com/example/catalog/releases/download/latest/index.json',
    'https://raw.githubusercontent.com/example/catalog/master/index.json',
    `${base}index.json?token=secret`,
    'https://example.com/index.json',
  ]) {
    assert.throws(() => createHostedCatalog({ pin: { ...f.pin, url } }));
  }
  assert.throws(() =>
    validateHostedCatalogIndex({ ...f.index, sources: [{ ...f.index.sources[0], license: '' }] }),
  );
  assert.throws(() => validateHostedCatalogIndex({ ...f.index, version: 2 }));
});

test('pinned index and shard mismatches fail closed without producing candidates', async () => {
  const badIndex = fixture();
  badIndex.bodies.set(badIndex.pin.url, Buffer.from('{}'));
  await assert.rejects(
    createHostedCatalog({ pin: badIndex.pin, fetcher: badIndex.fetcher }).sync(),
    /integrity/,
  );
  assert.equal(badIndex.calls.length, 1);
  const badShard = fixture();
  badShard.bodies.set(required(badShard.index.shards[0]).url, Buffer.from(`${badShard.shard} `));
  await assert.rejects(
    createHostedCatalog({ pin: badShard.pin, fetcher: badShard.fetcher }).sync(),
    /integrity|maxBytes/,
  );
});

test('resource lookup is pinned by release/shard/record and returns raw verified bytes for host normalization', async () => {
  const f = fixture('cheats');
  const catalog = createHostedCatalog({ pin: f.pin, fetcher: f.fetcher });
  const ref = { release: 'v1', shardId: 'nes-cheats', recordId: 'original' };
  const resource = await catalog.resource(ref);
  assert.deepEqual(Buffer.from(resource.bytes), f.resource);
  assert.ok(Buffer.from(resource.bytes).toString().includes('enable = "true"'));
  assert.equal(resource.sha256, digest(f.resource));
  assert.equal(resource.kind, 'cheats');
  assert.equal(resource.format, 'retroarch-cht');
  await assert.rejects(catalog.resource({ ...ref, release: 'v2' }), /release changed/);
  await assert.rejects(catalog.resource({ ...ref, recordId: 'missing' }), /Unknown/);
  await assert.rejects(
    catalog.resource({ ...ref, url: 'https://example.com' } as typeof ref),
    /Invalid/,
  );
  assert.equal(f.calls.length, 3);
});

test('resource hash/length bounds reject tampering and oversized streams', async () => {
  const f = fixture('cheats');
  f.bodies.set(required(f.record.resource).url, Buffer.from('x'.repeat(f.resource.length)));
  await assert.rejects(
    createHostedCatalog({ pin: f.pin, fetcher: f.fetcher }).resource({
      release: 'v1',
      shardId: 'nes-cheats',
      recordId: 'original',
    }),
    /integrity/,
  );
  const good = fixture('cheats');
  const fetcher: typeof fetch = async (url, init) =>
    String(url) === good.record.resource?.url
      ? new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(good.resource.length + 1));
              controller.close();
            },
          }),
        )
      : good.fetcher(url, init);
  await assert.rejects(
    createHostedCatalog({ pin: good.pin, fetcher }).resource({
      release: 'v1',
      shardId: 'nes-cheats',
      recordId: 'original',
    }),
    /too large/,
  );
});

test('manual redirects allow GitHub signed asset hosts without forwarding credentials, and reject private targets', async () => {
  const f = fixture();
  const redirected: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const target = String(url);
    redirected.push(target);
    assert.equal(init?.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    if (target === f.pin.url)
      return new Response(null, {
        status: 302,
        headers: {
          location:
            'https://release-assets.githubusercontent.com/original/catalog?sig=public-artifact',
        },
      });
    if (target.startsWith('https://release-assets.githubusercontent.com/'))
      return new Response(f.bodies.get(f.pin.url));
    return f.fetcher(url, init);
  };
  await createHostedCatalog({ pin: f.pin, fetcher }).sync();
  assert.ok(redirected.some((url) => url.includes('?sig=')));
  let attempts = 0;
  await assert.rejects(
    createHostedCatalog({
      pin: f.pin,
      fetcher: async () => {
        attempts++;
        return new Response(null, {
          status: 302,
          headers: { location: 'https://127.0.0.1/private' },
        });
      },
    }).index(),
    /request failed/,
  );
  assert.equal(attempts, 1);
  let loops = 0;
  await assert.rejects(
    createHostedCatalog({
      pin: f.pin,
      fetcher: async () => {
        loops++;
        return new Response(null, { status: 302, headers: { location: f.pin.url } });
      },
    }).index(),
    /request failed/,
  );
  assert.equal(loops, 4);
});

test('sync downloads selected systems only and search sends no ROM facts or private search terms', async () => {
  const f = fixture();
  const descriptor = required(f.index.shards[0]);
  f.index.shards.push({
    ...descriptor,
    id: 'snes-metadata',
    systemId: 'com.provenance.snes',
    url: `${base}snes.json`,
  });
  repin(f);
  const catalog = createHostedCatalog({ pin: f.pin, fetcher: f.fetcher });
  assert.deepEqual(await catalog.sync({ systemIds: [systemId] }), {
    release: 'v1',
    shards: 1,
    records: 1,
  });
  await required(catalog.providers()[0]).search({
    name: 'private-owner-game.nes',
    systemId,
    size: 16,
    crc32: '12345678',
    online: true,
    companions: [],
  });
  assert.ok(f.calls.every((call) => !JSON.stringify(call).includes('private-owner-game')));
  assert.equal(
    await catalog.metadata({
      name: 'other.rom',
      systemId: 'com.provenance.gba',
      online: true,
      companions: [],
    }),
    null,
  );
});

test('duplicate resource variants retain separate pinned references despite shared base identity', async () => {
  const f = fixture('patch', {
    metadata: { patchType: 'translation', language: 'en' },
    resource: { url: `${base}one.ips`, sha256: digest('PATCHEOF'), bytes: 8, format: 'ips' },
  });
  const second = {
    ...f.record,
    id: 'other',
    resource: { ...required(f.record.resource), url: `${base}two.ips` },
  };
  const shard = encode({
    version: 1,
    release: 'v1',
    kind: 'patch',
    systemId,
    records: [f.record, second],
  });
  const descriptor = required(f.index.shards[0]);
  descriptor.records = 2;
  descriptor.bytes = shard.length;
  descriptor.sha256 = digest(shard);
  f.bodies.set(descriptor.url, shard);
  repin(f);
  const provider = required(
    createHostedCatalog({ pin: f.pin, fetcher: f.fetcher })
      .providers()
      .find((provider) => provider.id === 'org.ecs.catalog.patches'),
  );
  const rows = await provider.search({
    name: 'renamed.nes',
    systemId,
    size: 16,
    crc32: '12345678',
    online: true,
    companions: [],
  });
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.id)).size, 2);
  assert.equal(rows[0]?.metadata.patchType, 'translation');
  assert.ok(
    rows.every(
      (row) =>
        row.metadata.resourceSha256 === digest('PATCHEOF') && row.metadata.catalogRelease === 'v1',
    ),
  );
});

test('hosted metadata resolver prevents legacy DAT downloads while preserving indexed front artwork', async () => {
  const { createLibretroProvider } = await import('../src/libretro-matching.js');
  const f = fixture();
  const catalog = createHostedCatalog({ pin: f.pin, fetcher: f.fetcher });
  const calls: string[] = [];
  const provider = createLibretroProvider(
    async (url) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          sha: 'a'.repeat(40),
          truncated: false,
          tree: [{ path: 'Named_Boxarts/Original Game (USA).png', type: 'blob', size: 1000 }],
        }),
      );
    },
    undefined,
    catalog.metadata,
  );
  const rows = await provider.search({
    name: 'renamed.nes',
    systemId,
    size: 16,
    crc32: '12345678',
    online: true,
    companions: [],
  });
  assert.equal(
    rows.filter((row) => row.kind === 'artwork' && row.confidence === 'checksum').length,
    1,
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.includes('/git/trees/'));
  const psp = createLibretroProvider(
    async (url) => {
      assert.ok(String(url).includes('/git/trees/'));
      return new Response(JSON.stringify({ sha: 'a'.repeat(40), truncated: false, tree: [] }));
    },
    undefined,
    async () => [],
  );
  assert.deepEqual(
    await psp.search({
      name: 'original.iso',
      systemId: 'com.provenance.psp',
      online: true,
      companions: [],
    }),
    [],
  );
});

test('abort rejects catalog fetch and a subsequent sync recovers without stale singleflight state', async () => {
  const f = fixture();
  let slow = true;
  const fetcher: typeof fetch = async (url, init) => {
    if (slow) {
      slow = false;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return f.fetcher(url, init);
  };
  const catalog = createHostedCatalog({ pin: f.pin, fetcher });
  const abort = new AbortController();
  const loading = catalog.sync({}, abort.signal);
  abort.abort();
  await assert.rejects(loading);
  assert.deepEqual(await catalog.sync(), { release: 'v1', shards: 1, records: 1 });
});

test('manifest returned by the client cannot be mutated to redirect a later resource request', async () => {
  const f = fixture('cheats');
  const client = createHostedCatalog({ pin: f.pin, fetcher: f.fetcher });
  const manifest = await client.index();
  assert.throws(() => {
    required(manifest.shards[0]).url =
      'https://github.com/example/catalog/releases/download/v1/replaced.json';
  });
  const resource = await client.resource({
    release: 'v1',
    shardId: 'nes-cheats',
    recordId: 'original',
  });
  assert.deepEqual(Buffer.from(resource.bytes), f.resource);
});

test('parsed/index LRU retains two systems and recompiles an evicted shard from bounded raw cache', async () => {
  const f = fixture();
  const texts = new Set<string>();
  f.index.shards = [];
  for (const [index, systemId] of [
    'com.provenance.nes',
    'com.provenance.snes',
    'com.provenance.gba',
  ].entries()) {
    const shard = encode({
      version: 1,
      release: 'v1',
      kind: 'metadata',
      systemId,
      records: [f.record],
    });
    const descriptor = {
      id: `part-${index}`,
      kind: 'metadata' as const,
      systemId,
      url: `${base}part-${index}.json`,
      sha256: digest(shard),
      bytes: shard.length,
      records: 1,
      sourceIds: ['original'],
    };
    f.index.shards.push(descriptor);
    f.bodies.set(descriptor.url, shard);
    texts.add(shard.toString());
  }
  repin(f);
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = (value, ...rest) => {
    if (texts.has(value)) parsed++;
    return parse(value, ...rest);
  };
  try {
    const catalog = createHostedCatalog({ pin: f.pin, fetcher: f.fetcher });
    await catalog.sync();
    assert.equal(parsed, 3);
    const request = {
      name: 'renamed.rom',
      systemId: 'com.provenance.gba',
      online: true,
      companions: [],
      size: 16,
      crc32: '12345678',
    };
    await catalog.metadata(request);
    assert.equal(parsed, 3);
    await catalog.metadata({ ...request, systemId: 'com.provenance.nes' });
    assert.equal(parsed, 4);
    assert.equal(f.calls.length, 4);
  } finally {
    JSON.parse = parse;
  }
});

test('fresh and expired immutable cache work offline only while exact pinned body digests remain valid', async () => {
  const f = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'ecs-hosted-catalog-'));
  let offlineCalls = 0;
  const offline: typeof fetch = async () => {
    offlineCalls++;
    throw new Error('Network unavailable');
  };
  const input = {
    name: 'renamed.nes',
    systemId,
    size: 16,
    crc32: '12345678',
    online: true,
    companions: [],
  };
  try {
    await createHostedCatalog({ pin: f.pin, fetcher: f.fetcher, cacheDirectory: directory }).sync();
    assert.equal(
      (
        await createHostedCatalog({
          pin: f.pin,
          fetcher: offline,
          cacheDirectory: directory,
        }).metadata(input)
      )?.length,
      1,
    );
    for (const url of [f.pin.url, required(f.index.shards[0]).url]) {
      const key = digest(url);
      const path = join(directory, `${key}.json`);
      const meta = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...meta, storedAt: 0 }));
    }
    const cached = createHostedCatalog({ pin: f.pin, fetcher: offline, cacheDirectory: directory });
    assert.equal((await cached.metadata(input))?.length, 1);
    assert.equal(offlineCalls, 0);
    assert.ok(
      cached
        .providers()
        .every((provider) => provider.name.includes('v1') && provider.name.length <= 80),
    );
    await writeFile(join(directory, `${digest(required(f.index.shards[0]).url)}.body`), 'corrupt');
    await assert.rejects(
      createHostedCatalog({ pin: f.pin, fetcher: offline, cacheDirectory: directory }).metadata(
        input,
      ),
      /request failed/,
    );
    assert.equal(offlineCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('worker registers hosted resource providers and rejects caller-supplied resource URLs', async () => {
  const { executeMatchingJob } = await import('../src/matching-worker.js');
  const list = await executeMatchingJob({ operation: 'list' });
  for (const id of ['org.ecs.catalog.cheats', 'org.ecs.catalog.patches'])
    assert.ok(list.plugins.some((plugin) => plugin.id === id && plugin.network));
  assert.ok(list.plugins.some((plugin) => plugin.id === 'org.ecs.libretro'));
  assert.ok(!list.plugins.some((plugin) => plugin.id === 'org.ecs.catalog.metadata'));
  await assert.rejects(
    executeMatchingJob({
      operation: 'catalog-resource',
      catalogResource: {
        release: 'v1',
        shardId: 'one',
        recordId: 'two',
        url: 'https://example.com',
      } as { release: string; shardId: string; recordId: string },
    }),
    /Invalid/,
  );
  await assert.rejects(
    executeMatchingJob({ operation: 'catalog-sync', catalogSystems: ['private/path'] }),
    /Invalid/,
  );
});

test('one system with more than eight shards stays warm and third-system eviction removes the oldest whole bucket', async () => {
  const f = fixture(),
    texts = new Map<string, string>();
  f.index.shards = [];
  for (const [systemId, count] of [
    ['com.provenance.nes', 10],
    ['com.provenance.snes', 2],
    ['com.provenance.gba', 1],
  ] as const) {
    for (let part = 0; part < count; part++) {
      const shard = encode({
        version: 1,
        release: 'v1',
        kind: 'metadata',
        systemId,
        records: [{ ...f.record, id: `part-${part}` }],
      });
      const descriptor = {
        id: `${systemId}-${part}`,
        kind: 'metadata' as const,
        systemId,
        url: `${base}${systemId}-${part}.json`,
        sha256: digest(shard),
        bytes: shard.length,
        records: 1,
        sourceIds: ['original'],
      };
      f.index.shards.push(descriptor);
      f.bodies.set(descriptor.url, shard);
      texts.set(shard.toString(), systemId);
    }
  }
  repin(f);
  const parse = JSON.parse,
    counts = new Map<string, number>();
  JSON.parse = (value, ...rest) => {
    const system = texts.get(value);
    if (system) counts.set(system, (counts.get(system) ?? 0) + 1);
    return parse(value, ...rest);
  };
  try {
    const catalog = createHostedCatalog({ pin: f.pin, fetcher: f.fetcher });
    await catalog.sync({ systemIds: ['com.provenance.nes', 'com.provenance.snes'] });
    const request = {
      name: 'renamed.rom',
      systemId: 'com.provenance.nes',
      online: true,
      companions: [],
      size: 16,
      crc32: '12345678',
    };
    await catalog.metadata(request);
    await catalog.metadata(request);
    assert.equal(counts.get('com.provenance.nes'), 10);
    await catalog.metadata({ ...request, systemId: 'com.provenance.gba' });
    await catalog.metadata(request);
    assert.equal(counts.get('com.provenance.nes'), 10);
    await catalog.metadata({ ...request, systemId: 'com.provenance.snes' });
    assert.equal(counts.get('com.provenance.snes'), 4);
  } finally {
    JSON.parse = parse;
  }
});

test('equivalent hosted metadata reconciles while preserving every immutable record reference', async () => {
  const f = fixture();
  const second = {
    ...f.record,
    id: 'other',
    name: 'another.bin',
    metadata: { genre: 'Original test' },
  };
  const shard = encode({
    version: 1,
    release: 'v1',
    kind: 'metadata',
    systemId,
    records: [f.record, second],
  });
  const descriptor = required(f.index.shards[0]);
  descriptor.records = 2;
  descriptor.bytes = shard.length;
  descriptor.sha256 = digest(shard);
  f.bodies.set(descriptor.url, shard);
  repin(f);
  const rows = await createHostedCatalog({ pin: f.pin, fetcher: f.fetcher }).metadata({
    name: 'renamed.nes',
    systemId,
    size: 16,
    crc32: '12345678',
    online: true,
    companions: [],
  });
  assert.equal(rows?.length, 1);
  assert.equal(rows?.[0]?.metadata.genre, 'Original test');
  const originals = JSON.parse(rows?.[0]?.metadata.matchProvenance ?? '[]');
  assert.deepEqual(
    originals.map((row: { metadata: { catalogRecord: string } }) => row.metadata.catalogRecord),
    ['original', 'other'],
  );
});
