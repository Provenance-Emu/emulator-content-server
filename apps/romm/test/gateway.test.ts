import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { issueToken } from '@ecs/auth';
import { openServer } from '@ecs/server';
import { DEFAULT_MATERIALIZE_QUOTA, streamZip, ZipProvider } from '@ecs/storage';
import { openGateway } from '../src/gateway.js';

interface Platform {
  id: number;
  name: string;
  rom_count: number;
  ecs_system_id?: string;
}

interface Rom {
  id: number;
  fs_name: string;
}

test('RomM browse, byte ranges and extractable GameCube and arcade downloads', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-romm-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const server = await openServer({ dataDir: join(base, 'data'), automaticMatching: false });
  const origin = await server.app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => server.close());

  const bootstrap = issueToken();
  server.catalog.saveBootstrapHash(bootstrap.hash);
  const setup = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
  });
  assert.equal(setup.statusCode, 201);
  const owner = server.catalog.listUsers()[0];
  assert.ok(owner);
  const library = server.catalog.createLibrary(owner.id, 'Shared games');
  const rootPath = join(base, 'library');
  const discOne = Buffer.from('generated disc one');
  const discTwo = Buffer.from('generated disc two');
  const playlist = Buffer.from('Discs/Disc 1.iso\nDiscs/Disc 2.iso\n');
  const chd = Buffer.from('generated GD-ROM fixture');
  const chip = Buffer.from('generated arcade cartridge chip');
  const zipChunks: Buffer[] = [];
  for await (const chunk of streamZip([
    { name: 'chip.bin', size: chip.length, open: async () => Readable.from([chip]) },
  ]))
    zipChunks.push(chunk);
  const cartridge = Buffer.concat(zipChunks);
  const single = Buffer.from('generated single GameCube fixture');
  for (const [path, bytes] of [
    ['GameCube/Single Game.iso', single],
    ['GameCube/Disc Set/Collection.m3u', playlist],
    ['GameCube/Disc Set/Discs/Disc 1.iso', discOne],
    ['GameCube/Disc Set/Discs/Disc 2.iso', discTwo],
    ['Naomi/cart.zip', cartridge],
    ['Naomi/cart/gdrom.chd', chd],
  ] as const) {
    const file = join(rootPath, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const root = server.catalog.createContentRoot({
    path: rootPath,
    label: 'Generated games',
    libraryId: library.id,
    actorId: owner.id,
  });
  const scan = await server.app.inject({
    method: 'POST',
    url: `/api/v1/roots/${root.id}/scan`,
    headers: { authorization: `Bearer ${setup.json().token}` },
  });
  assert.equal(scan.statusCode, 200);
  const grant = (libraryId: string) => {
    const issued = issueToken();
    const grant = server.catalog.createGuestGrant({
      libraryId,
      itemId: null,
      capabilities: ['read'],
      tokenHash: issued.hash,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      createdBy: owner.id,
    });
    return { grant, authorization: `Bearer ${issued.token}` };
  };
  const shared = grant(library.id);
  const other = grant(server.catalog.createLibrary(owner.id, 'Other').id);
  const indexPath = join(base, 'ids.sqlite');
  let gateway = openGateway({ origin, indexPath });
  t.after(() => gateway.close());
  let address = await gateway.listen({ host: '127.0.0.1', port: 0 });
  const request = (path: string, init: RequestInit = {}, authorization = shared.authorization) =>
    fetch(address + path, { ...init, headers: { ...init.headers, authorization } });
  const json = async <T>(path: string): Promise<T> => {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    return (await response.json()) as T;
  };
  const downloadPath = (rom: Rom) =>
    `/api/roms/${rom.id}/content/${encodeURIComponent(rom.fs_name)}`;

  assert.equal((await fetch(`${address}/api/platforms`)).status, 401);
  assert.equal((await request('/api/platforms', {}, 'Bearer invalid')).status, 401);
  const platforms = await json<Platform[]>('/api/platforms');
  assert.equal(platforms.length, 2);
  const gc = platforms.find((platform) => /GameCube/i.test(platform.name));
  const naomi = platforms.find((platform) => /NAOMI/i.test(platform.name));
  assert.ok(gc);
  assert.ok(naomi);
  assert.equal(gc.rom_count, 2);
  assert.equal(naomi.rom_count, 1);

  const page = (query: string) => json<{ items: Rom[]; total?: number }>(`/api/roms?${query}`);
  const gcQuery = `platform_ids=${gc.id}&platform_id=${gc.id}`;
  const gameCube = await page(`${gcQuery}&limit=250`);
  assert.equal(gameCube.total, 2);
  const firstPage = await page(`${gcQuery}&limit=1&offset=0`);
  const secondPage = await page(`${gcQuery}&limit=1&offset=1`);
  assert.deepEqual([...firstPage.items, ...secondPage.items], gameCube.items);
  const {
    items: [game],
  } = await page(`${gcQuery}&search_term=Single%20Game`);
  const discs = gameCube.items.find((entry) => entry.fs_name === 'Collection.zip');
  const {
    items: [arcade],
  } = await page(`platform_id=${naomi.id}`);
  assert.ok(game);
  assert.ok(discs);
  assert.ok(arcade);
  assert.equal(arcade.fs_name, 'cart (ROM set).zip');
  assert.equal(game.fs_name, 'Single Game.iso');
  assert.deepEqual(await json(`/api/roms/${game.id}`), game);
  assert.deepEqual(await json(`/api/saves?rom_id=${game.id}`), []);
  assert.equal((await request(downloadPath(game), {}, other.authorization)).status, 404);
  assert.equal((await request(`/api/roms/${game.id}/content/wrong.iso`)).status, 404);

  const plain = await request(downloadPath(game));
  assert.equal(plain.status, 200);
  assert.deepEqual(Buffer.from(await plain.arrayBuffer()), single);
  const head = await request(downloadPath(game), { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(
    head.headers.get('content-length'),
    String(single.length),
    JSON.stringify(Object.fromEntries(head.headers)),
  );
  const ranged = await request(downloadPath(game), { headers: { Range: 'bytes=2-6' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 2-6/${single.length}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), single.subarray(2, 7));

  const checkArchive = async (rom: Rom, expected: Record<string, Buffer>) => {
    const metadata = await request(downloadPath(rom), { method: 'HEAD' });
    assert.equal(metadata.status, 200);
    assert.match(metadata.headers.get('content-type') ?? '', /zip/);
    assert.equal(metadata.headers.get('accept-ranges'), 'none');
    const response = await request(downloadPath(rom));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /zip/);
    const bytes = Buffer.from(await response.arrayBuffer());
    const file = join(base, `archive-${rom.id}.zip`);
    await writeFile(file, bytes);
    const zip = new ZipProvider();
    const quota = { ...DEFAULT_MATERIALIZE_QUOTA, maxNesting: 1 };
    const inspected = await zip.inspect(file, quota);
    assert.ok(inspected);
    const members = inspected.entries;
    assert.deepEqual(members.map((entry) => entry.path).sort(), Object.keys(expected).sort());
    for (const member of members) {
      const located = await zip.resolve(file, member.entryId, quota);
      assert.equal(located?.kind, 'range');
      if (located?.kind !== 'range') throw new Error('Expected a stored ZIP entry');
      assert.deepEqual(
        bytes.subarray(located.offset, located.offset + located.entry.uncompressedSize),
        expected[member.path],
      );
    }
  };
  await checkArchive(discs, {
    'Collection.m3u': Buffer.from('Disc 1.iso\nDisc 2.iso\n'),
    'Disc 1.iso': discOne,
    'Disc 2.iso': discTwo,
  });
  await checkArchive(arcade, { 'Naomi/cart.zip': cartridge, 'Naomi/cart/gdrom.chd': chd });

  await gateway.close();
  gateway = openGateway({ origin, indexPath });
  address = await gateway.listen({ host: '127.0.0.1', port: 0 });
  assert.deepEqual(await json(`/api/roms/${game.id}`), game);
  server.catalog.revokeGuestGrant(shared.grant.id, owner.id);
  assert.equal((await request(downloadPath(game))).status, 401);
});

test('Jaguar browse request counts across cart and CD libraries', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-jaguar-browse-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const server = await openServer({ dataDir: join(base, 'data'), automaticMatching: false });
  t.after(() => server.close());

  const calls: { path: string; bytes: number }[] = [];
  let legacyBrowse = false;
  server.app.addHook('onSend', async (request, _reply, payload) => {
    if (
      legacyBrowse &&
      request.routeOptions.url === '/api/v1/browse' &&
      typeof payload === 'string'
    ) {
      const page = JSON.parse(payload);
      for (const row of page.items) delete row.romDownload;
      payload = JSON.stringify(page);
    }
    if (request.url.startsWith('/api/v1/'))
      calls.push({
        path: request.routeOptions.url ?? request.url,
        bytes: typeof payload === 'string' ? Buffer.byteLength(payload) : 0,
      });
    return payload;
  });
  const origin = await server.app.listen({ host: '127.0.0.1', port: 0 });
  const bootstrap = issueToken();
  server.catalog.saveBootstrapHash(bootstrap.hash);
  const setup = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
  });
  assert.equal(setup.statusCode, 201);
  const owner = server.catalog.listUsers()[0];
  assert.ok(owner);
  const [first, second] = [
    server.catalog.createLibrary(owner.id, 'Shelf A'),
    server.catalog.createLibrary(owner.id, 'Shelf B'),
  ].sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.ok(first && second);
  const cart = 'com.provenance.jaguar';
  const cd = 'com.provenance.jaguarcd';
  const uploadGame = (
    libraryId: string,
    systemIdentifier: string,
    title: string,
    paths: string[],
  ) => {
    const item = server.catalog.createItem({
      libraryId,
      systemIdentifier,
      title,
      md5: null,
      crc: null,
      actorId: owner.id,
    });
    for (const relativePath of paths)
      server.catalog.completeUpload({
        uploadId: server.catalog.createUpload({ userId: owner.id, guestGrantId: null, libraryId })
          .id,
        itemId: item.id,
        kind: 'rom',
        displayName: relativePath,
        relativePath,
        baseRevision: server.catalog.getItem(item.id)?.revision ?? 1,
        sha256: 'a'.repeat(64),
        size: 8,
        md5: 'b'.repeat(32),
        crc: '12345678',
        shareable: true,
        actorId: owner.id,
        locationId: null,
      });
  };
  for (let i = 0; i < 120; i++) {
    const name = `Cart ${String(i).padStart(3, '0')}`;
    uploadGame(first.id, cart, name, [`${name}.j64`]);
  }
  for (let i = 0; i < 20; i++) {
    const name = `Disc ${String(i).padStart(3, '0')}`;
    uploadGame(second.id, cd, name, [`${name}.cue`, `${name}.bin`]);
  }
  uploadGame(first.id, 'com.provenance.nes', 'Unrelated game', ['Unrelated.nes']);

  const gateway = openGateway({ origin, indexPath: join(base, 'ids.sqlite') });
  t.after(() => gateway.close());
  const headers = { authorization: `Bearer ${setup.json().token}` };
  const capabilities = (await server.app.inject({ url: '/api/v1/capabilities' })).json();
  assert.equal(capabilities.features.romDownloadSummaries, true);
  assert.equal(capabilities.features.gameCompanions, true);
  const api = await server.app.inject({ url: '/openapi.yaml' });
  assert.equal(api.statusCode, 200);
  assert.match(api.body, /operationId: sourceCompanions/);
  const observe = async (name: string, app: typeof server.app, url: string) => {
    calls.length = 0;
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200, url);
    const counts = Object.fromEntries(
      [...new Set(calls.map((call) => call.path))].map((path) => [
        path,
        calls.filter((call) => call.path === path).length,
      ]),
    );
    t.diagnostic(
      JSON.stringify({
        name,
        upstreamRequests: calls.length,
        counts,
        upstreamBytes: calls.reduce((bytes, call) => bytes + call.bytes, 0),
        responseBytes: Buffer.byteLength(response.body),
      }),
    );
    return response.json();
  };
  const native = `/api/v1/browse?libraryId=${first.id}&category=games&systemId=${cart}&limit=10`;
  const nativePage = await observe('native first', server.app, native);
  assert.equal(nativePage.items.length, 10);
  assert.equal(calls.length, 1);
  assert.ok(nativePage.nextCursor);
  const next = await observe(
    'native next',
    server.app,
    `${native}&cursor=${nativePage.nextCursor}`,
  );
  assert.equal(next.items[0].name, 'Cart 010');
  assert.equal(calls.length, 1);
  const summaryPage = await observe(
    'native first with download summary',
    server.app,
    `${native}&includeRomDownload=true`,
  );
  assert.deepEqual(summaryPage.items[0].romDownload, {
    romFileCount: 1,
    requiresSystemFiles: false,
    filename: 'Cart 000.j64',
    sizeBytes: 8,
  });

  const platformList = (await observe(
    'gateway platforms',
    gateway,
    '/api/platforms',
  )) as Platform[];
  const cartId = platformList.find((platform) => platform.name === 'Atari Jaguar')?.id;
  const cdId = platformList.find((platform) => platform.name === 'Atari Jaguar CD')?.id;
  assert.ok(cartId && cdId);
  const query = `/api/roms?platform_ids=${cartId},${cdId}&limit=10`;
  const cold = await observe('gateway first', gateway, query);
  assert.equal(cold.items.length, 10);
  assert.equal(cold.items[0].fs_name, 'Cart 000.j64');
  assert.equal(cold.items[0].path_cover_large, undefined);
  assert.ok(calls.every((call) => !call.path.endsWith('/manifest')));
  assert.ok(calls.length <= 3);
  const deep = await observe('gateway offset 125', gateway, `${query}&offset=125`);
  assert.equal(deep.items.length, 10);
  assert.equal(deep.items[0].fs_name, 'Disc 005.zip');
  assert.equal(deep.items[0].platform_id, cdId);
  assert.equal(deep.items[0].platform_slug, 'jaguarcd');
  assert.ok(calls.every((call) => !call.path.endsWith('/manifest')));
  assert.ok(calls.length <= 5);
  const exactTotal = await observe(
    'gateway explicit total',
    gateway,
    `/api/roms?platform_ids=${cartId},${cdId}&limit=100&with_total=true`,
  );
  assert.equal(exactTotal.items.length, 100);
  assert.equal(exactTotal.total, 140);
  assert.ok(calls.every((call) => !call.path.endsWith('/manifest')));
  legacyBrowse = true;
  const fallback = await observe(
    'gateway against legacy browse',
    gateway,
    `${query}&search_term=Cart%20000`,
  );
  assert.deepEqual(fallback.items, [cold.items[0]]);
  assert.equal(calls.filter((call) => call.path.endsWith('/manifest')).length, 1);
  legacyBrowse = false;
  const catalogItem = await gateway.inject({
    url: `/api/roms/${cold.items[0].id}/ecs-companions`,
    headers,
  });
  assert.deepEqual(catalogItem.json(), { supportedKinds: [], items: [] });

  const rootPath = join(base, 'local');
  await mkdir(join(rootPath, 'Jaguar'), { recursive: true });
  await writeFile(join(rootPath, 'Jaguar', 'Local Jaguar.j64'), Buffer.from('cart'));
  const root = server.catalog.createContentRoot({
    path: rootPath,
    label: 'Scanned',
    libraryId: first.id,
    actorId: owner.id,
  });
  const scan = await server.app.inject({
    method: 'POST',
    url: `/api/v1/roots/${root.id}/scan`,
    headers,
  });
  assert.equal(scan.statusCode, 200);
  const source = server.catalog
    .listSources(root.id)
    .find((file) => file.displayName === 'Local Jaguar.j64');
  assert.ok(source);
  assert.equal(source.systemId, cart);
  const patch = Buffer.concat([
    Buffer.from('BPS1'),
    Buffer.from([0x84, 0x85, 0x80]),
    Buffer.alloc(12),
  ]);
  patch.writeUInt32LE(0x12345678, patch.length - 12);
  patch.writeUInt32LE(crc32(patch.subarray(0, -4)), patch.length - 4);
  const digest = createHash('sha256').update(patch).digest('hex');
  const cover = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kfFAAAAAASUVORK5CYII=',
    'base64',
  );
  const save = (
    kind: 'patch' | 'artwork',
    bytes: Buffer,
    originKind: 'system_file' | null = null,
  ) =>
    server.catalog.saveSourceMatch(
      source.id,
      server.catalog.sourceMatches(source.id).revision,
      kind,
      {
        id: `${kind}-${originKind ?? 'public'}`,
        providerId: 'fixture',
        kind,
        title: 'Local Jaguar',
        confidence: 'local',
        metadata: {},
        originKind,
        contentAvailable: true,
        contentType: kind === 'artwork' ? 'image/png' : 'application/octet-stream',
        fileName: kind === 'artwork' ? 'cover.png' : 'translation.bps',
        updatedAt: new Date().toISOString(),
      },
      bytes,
      owner.id,
    );
  save('artwork', cover);
  save('patch', patch);
  const guest = (libraryId: string) => {
    const token = issueToken();
    server.catalog.createGuestGrant({
      libraryId,
      itemId: null,
      tokenHash: token.hash,
      capabilities: ['read'],
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      createdBy: owner.id,
    });
    return { authorization: `Bearer ${token.token}` };
  };
  const allowed = guest(first.id);
  const denied = guest(second.id);
  const local = (
    await gateway.inject({
      url: `/api/roms?platform_ids=${cartId}&search_term=Local%20Jaguar`,
      headers: allowed,
    })
  ).json().items[0];
  assert.equal(local.platform_slug, 'jaguar');
  // Jaguar resolves the name and byte size on demand before staging a gateway cartridge.
  const details = await gateway.inject({ url: `/api/roms/${local.id}`, headers: allowed });
  assert.equal(details.statusCode, 200);
  assert.equal(details.json().id, local.id);
  assert.equal(details.json().fs_name, 'Local Jaguar.j64');
  assert.equal(details.json().fs_size_bytes, 4);
  const cartContent = `/api/roms/${local.id}/content/${encodeURIComponent(details.json().fs_name)}`;
  const downloadedCart = await gateway.inject({ url: cartContent, headers: allowed });
  assert.equal(downloadedCart.statusCode, 200);
  assert.deepEqual(downloadedCart.rawPayload, Buffer.from('cart'));
  assert.equal((await gateway.inject({ url: cartContent, headers: denied })).statusCode, 404);
  const coverPath = `/assets/romm/ecs/${local.id}/cover`;
  assert.equal(local.path_cover_large, coverPath);
  const smallCover = `/assets/romm/resources/ecs/${local.id}/cover`;
  assert.equal(local.path_cover_small, smallCover);
  calls.length = 0;
  const image = await gateway.inject({ url: coverPath, headers: allowed });
  assert.deepEqual(image.rawPayload, cover);
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/v1/sources/:sourceId/matches/selections/:kind/content'],
  );
  assert.equal(image.headers['cache-control'], 'private, no-cache');
  assert.deepEqual((await gateway.inject({ url: smallCover, headers: allowed })).rawPayload, cover);
  const conditional = { 'if-none-match': image.headers.etag };
  assert.equal(
    (await gateway.inject({ url: coverPath, headers: { ...allowed, ...conditional } })).statusCode,
    304,
  );
  assert.equal(
    (await gateway.inject({ url: coverPath, headers: { ...denied, ...conditional } })).statusCode,
    404,
  );

  const nativeCompanions = `/api/v1/sources/${source.id}/companions`;
  const gatewayCompanions = `/api/roms/${local.id}/ecs-companions`;
  const listed = await gateway.inject({ url: gatewayCompanions, headers: allowed });
  assert.equal(listed.statusCode, 200);
  const companion = {
    id: digest,
    kind: 'patch',
    required: false,
    filename: 'translation.bps',
    sizeBytes: patch.length,
    sha256: digest,
    format: 'bps',
    base: { crc32: '12345678', sizeBytes: 4 },
  };
  const gatewayContent = `${gatewayCompanions}/${digest}/content`;
  assert.deepEqual(listed.json(), {
    supportedKinds: ['patch'],
    items: [{ ...companion, contentPath: gatewayContent }],
  });
  assert.deepEqual((await server.app.inject({ url: nativeCompanions, headers: allowed })).json(), {
    supportedKinds: ['patch'],
    items: [{ ...companion, contentPath: `${nativeCompanions}/${digest}/content` }],
  });
  assert.deepEqual(
    (await gateway.inject({ url: gatewayContent, headers: allowed })).rawPayload,
    patch,
  );
  assert.equal((await gateway.inject({ url: gatewayContent, headers: denied })).statusCode, 404);
  save('patch', patch, 'system_file');
  assert.deepEqual((await gateway.inject({ url: gatewayCompanions, headers: allowed })).json(), {
    supportedKinds: ['patch'],
    items: [],
  });
  assert.equal((await gateway.inject({ url: gatewayContent, headers: allowed })).statusCode, 404);
  assert.equal((await gateway.inject({ url: gatewayContent, headers })).statusCode, 200);
  save('patch', Buffer.from('PATCHEOF'));
  assert.equal((await gateway.inject({ url: gatewayContent, headers })).statusCode, 404);

  const customSystem = 'example.system.cartridge';
  uploadGame(second.id, customSystem, 'Custom game', ['Custom.bin']);
  const custom = (
    (await gateway.inject({ url: '/api/platforms', headers: denied })).json() as Platform[]
  ).find((entry) => entry.ecs_system_id === customSystem);
  assert.ok(custom);
  const scoped = `/api/roms?platform_ids=${custom.id}`;
  assert.equal(
    (await gateway.inject({ url: scoped, headers: denied })).json().items[0].fs_name,
    'Custom.bin',
  );
  assert.deepEqual((await gateway.inject({ url: scoped, headers: allowed })).json().items, []);
});
