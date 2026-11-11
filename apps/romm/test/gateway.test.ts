import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '@ecs/server';
import { DEFAULT_MATERIALIZE_QUOTA, streamZip, ZipProvider } from '@ecs/storage';
import { openGateway } from '../src/gateway.js';

interface Platform {
  id: number;
  name: string;
  rom_count: number;
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
