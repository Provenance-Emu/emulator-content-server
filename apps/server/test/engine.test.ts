/**
 * The sync engine ships in `@ecs/client`, but it is the only thing that uses
 * the cursor, the ranged resume, and the upload offset together. It is a dev
 * dependency here so this suite proves the shipped client speaks what the
 * routes actually serve, instead of a stub that agrees with itself.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { ContentClient, ContentError } from '@ecs/client';
import { openServer } from '../src/index.js';

async function fixture(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const server = await openServer({
    dataDir: dir,
    limits: { maxUploadBytes: 1024 * 1024, maxLibraryBytes: 8 * 1024 * 1024 },
  });
  const origin = await server.app.listen({ port: 0, host: '127.0.0.1' });
  const bootstrap = issueToken();
  server.catalog.saveBootstrapHash(bootstrap.hash);
  const owner = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
  });
  assert.equal(owner.statusCode, 201, owner.body);
  const token = (owner.json() as { token: string }).token;
  const auth = { authorization: `Bearer ${token}` };
  const libraries = await server.app.inject({
    method: 'GET',
    url: '/api/v1/libraries',
    headers: auth,
  });
  const libraryId = (libraries.json() as { items: Array<{ id: string }> }).items[0]?.id;
  assert.ok(libraryId);
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/v1/items',
    headers: auth,
    payload: { libraryId, systemIdentifier: 'com.provenance.nes', title: 'Engine' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const itemId = (created.json() as { id: string }).id;
  return {
    app: server.app,
    auth,
    libraryId,
    itemId,
    client: new ContentClient(origin, token),
    async revision(): Promise<number> {
      const item = await server.app.inject({
        method: 'GET',
        url: `/api/v1/items/${itemId}`,
        headers: auth,
      });
      return (item.json() as { revision: number }).revision;
    },
    async close(): Promise<void> {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function collect(body: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  assert.ok(body, 'a download that carries content has a body');
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function pattern(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
  return bytes;
}

test('the client engine pages the feed and resumes a half-held download', async () => {
  const ecs = await fixture('ecs-engine-');
  try {
    const { client } = ecs;
    assert.equal((await client.capabilities()).protocol.major, 1);

    const rom = pattern(4096);
    const digest = createHash('sha256').update(rom).digest('hex');
    const asset = await client.upload({
      libraryId: ecs.libraryId,
      itemId: ecs.itemId,
      kind: 'rom',
      displayName: 'Engine.nes',
      relativePath: 'Engine.nes',
      baseRevision: await ecs.revision(),
      body: rom,
    });
    assert.equal(asset.sha256, digest);
    assert.equal(asset.size, rom.length);

    const half = rom.length / 2;
    const resumed = await client.download(asset.id, { localBytes: half, etag: `"${digest}"` });
    assert.equal(resumed.instruction, 'append');
    assert.equal(resumed.offset, half);
    assert.equal(resumed.totalBytes, rom.length, 'the whole size, not the remainder');
    const tail = await collect(resumed.body);
    assert.equal(tail.length, half, 'one ranged request, not a restart');
    assert.deepEqual(Buffer.concat([rom.subarray(0, half), tail]), rom);

    const changedUnderneath = await client.download(asset.id, {
      localBytes: half,
      etag: '"not-the-asset-we-have"',
    });
    assert.equal(changedUnderneath.instruction, 'restart');
    assert.equal(changedUnderneath.offset, 0);
    assert.deepEqual(await collect(changedUnderneath.body), rom);

    const alreadyWhole = await client.download(asset.id, {
      localBytes: rom.length,
      etag: `"${digest}"`,
    });
    assert.equal(alreadyWhole.instruction, 'unsatisfiable');
    assert.equal(alreadyWhole.body, null);

    const fresh = await client.download(asset.id);
    assert.equal(fresh.instruction, 'append');
    assert.equal(fresh.totalBytes, rom.length);
    await fresh.body?.cancel();

    const pages = [];
    for await (const page of client.changePages({ cursor: '0', limit: 2 })) pages.push(page);
    assert.ok(pages.length > 1, 'a limit smaller than the feed forces more than one page');
    const last = pages.at(-1);
    assert.ok(last);
    assert.equal(last.changes.length, 0, 'the walk ends on the page that adds nothing');
    const cursors = pages.flatMap((page) => page.changes.map((change) => change.cursor));
    assert.deepEqual(
      cursors,
      [...cursors].sort((a, b) => a - b),
      'the feed stays monotonic',
    );
    assert.deepEqual(
      await client.changes({ cursor: '0', limit: 2 }),
      pages[0],
      'replaying a cursor returns the same page',
    );

    await assert.rejects(
      client.upload({
        libraryId: ecs.libraryId,
        itemId: ecs.itemId,
        kind: 'rom',
        displayName: 'Stale.nes',
        relativePath: 'Stale.nes',
        baseRevision: 1,
        body: Buffer.from('stale rom bytes that are long enough', 'utf8'),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ContentError);
        assert.equal(error.status, 409, 'a stale ROM is refused rather than retried');
        return true;
      },
    );
  } finally {
    await ecs.close();
  }
});

test('an interrupted upload continues from the offset the server holds', async () => {
  const ecs = await fixture('ecs-resume-');
  const save = pattern(600);
  const digest = createHash('sha256').update(save).digest('hex');
  const real = globalThis.fetch;
  let truncations = 1;
  globalThis.fetch = async (input: Parameters<typeof real>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (truncations > 0 && init?.method === 'PUT' && url.endsWith('/content')) {
      truncations -= 1;
      const body = init.body as Uint8Array;
      const headers = { ...(init.headers as Record<string, string>) };
      headers['content-range'] = `bytes 0-199/${save.length}`;
      await real(url, { ...init, body: body.subarray(0, 200), headers });
      throw new TypeError('fetch failed');
    }
    return real(input, init);
  };
  try {
    const asset = await ecs.client.upload({
      libraryId: ecs.libraryId,
      itemId: ecs.itemId,
      kind: 'battery_save',
      displayName: 'Engine.sav',
      relativePath: 'Engine.sav',
      baseRevision: await ecs.revision(),
      body: save,
    });
    assert.equal(truncations, 0, 'the first attempt was the one that was cut short');
    assert.equal(asset.size, save.length);
    assert.equal(asset.sha256, digest, 'the resumed bytes landed where the first attempt stopped');

    const whole = await ecs.client.download(asset.id);
    assert.deepEqual(await collect(whole.body), save);
  } finally {
    globalThis.fetch = real;
    await ecs.close();
  }
});

test('a chunked upload reports progress and re-sends only the piece that failed', async () => {
  const ecs = await fixture('ecs-chunked-');
  const rom = pattern(1000);
  const real = globalThis.fetch;
  const ranges: string[] = [];
  let refusals = 1;
  globalThis.fetch = async (input: Parameters<typeof real>[0], init?: RequestInit) => {
    if (init?.method !== 'PUT') return real(input, init);
    const headers = init.headers as Record<string, string>;
    ranges.push(headers['content-range'] ?? '');
    if (refusals > 0 && headers['content-range'] === 'bytes 400-799/1000') {
      refusals -= 1;
      throw new TypeError('fetch failed');
    }
    return real(input, init);
  };
  try {
    const seen: number[] = [];
    const asset = await ecs.client.upload({
      libraryId: ecs.libraryId,
      itemId: ecs.itemId,
      kind: 'rom',
      displayName: 'Chunked.nes',
      relativePath: 'Chunked.nes',
      baseRevision: await ecs.revision(),
      body: rom,
      chunkBytes: 400,
      onProgress: (sent) => seen.push(sent),
    });
    assert.equal(asset.sha256, createHash('sha256').update(rom).digest('hex'));
    assert.deepEqual(
      ranges,
      ['bytes 0-399/1000', 'bytes 400-799/1000', 'bytes 400-799/1000', 'bytes 800-999/1000'],
      'the failed piece is sent again and the ones before it are not',
    );
    assert.deepEqual(seen, [0, 400, 400, 800, 1000], 'progress reports each piece that landed');
  } finally {
    globalThis.fetch = real;
    await ecs.close();
  }
});

test('collecting an asset asks only for the bytes a broken stream left behind', async () => {
  const ecs = await fixture('ecs-collect-');
  const rom = pattern(900);
  const real = globalThis.fetch;
  /** Ranges the client asked for, which is what shows whether it resumed. */
  const asked: Array<string | null> = [];
  let cuts = 1;
  globalThis.fetch = async (input: Parameters<typeof real>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const reading = url.endsWith('/content') && init?.method === undefined;
    if (reading) asked.push((init?.headers as Record<string, string>)?.range ?? null);
    const response = await real(input, init);
    if (!reading || cuts === 0) return response;
    cuts -= 1;
    // Headers intact and the body stopping early, which is what a connection
    // dropped part way through looks like to a reader.
    const head = new Uint8Array(await response.arrayBuffer()).subarray(0, 400);
    let delivered = false;
    return new Response(
      // Erroring a stream clears whatever is queued, so the head has to be
      // handed over on one pull and the break raised on the next.
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (delivered) throw new TypeError('network connection was lost');
          delivered = true;
          controller.enqueue(head);
        },
      }),
      { status: response.status, headers: response.headers },
    );
  };
  try {
    const asset = await ecs.client.upload({
      libraryId: ecs.libraryId,
      itemId: ecs.itemId,
      kind: 'rom',
      displayName: 'Collect.nes',
      relativePath: 'Collect.nes',
      baseRevision: await ecs.revision(),
      body: rom,
    });
    const seen: number[] = [];
    const collected = await ecs.client.collect(asset.id, {
      onProgress: (received) => seen.push(received),
    });
    assert.equal(cuts, 0, 'the first body was the one that was cut short');
    assert.deepEqual(Buffer.from(collected.bytes), rom);
    assert.equal(collected.etag, `"${createHash('sha256').update(rom).digest('hex')}"`);
    assert.deepEqual(asked, [null, 'bytes=400-'], 'the retry resumed instead of restarting');
    assert.ok(seen.includes(400), 'progress reported what survived the break');
    assert.equal(seen.at(-1), rom.length);
  } finally {
    globalThis.fetch = real;
    await ecs.close();
  }
});

test('a resumed session sends only the bytes the server is missing', async () => {
  const ecs = await fixture('ecs-offset-');
  try {
    const save = pattern(300);
    const opened = await ecs.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: ecs.auth,
      payload: { libraryId: ecs.libraryId },
    });
    assert.equal(opened.statusCode, 201, opened.body);
    const uploadId = (opened.json() as { id: string }).id;
    const sent = await ecs.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${uploadId}/content`,
      headers: {
        ...ecs.auth,
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-99/${save.length}`,
      },
      payload: save.subarray(0, 100),
    });
    assert.equal(sent.statusCode, 204, sent.body);

    const asset = await ecs.client.upload(
      {
        libraryId: ecs.libraryId,
        itemId: ecs.itemId,
        kind: 'battery_save',
        displayName: 'Engine.sav',
        relativePath: 'Engine.sav',
        baseRevision: await ecs.revision(),
        body: save,
        uploadId,
      },
      1,
    );
    assert.equal(
      asset.sha256,
      createHash('sha256').update(save).digest('hex'),
      'one attempt, so the offset had to be right the first time',
    );
  } finally {
    await ecs.close();
  }
});
