import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

test('a scanned folder stays registered when the disk is gone and hides its path', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ecs-source-'));
  const dataDir = join(base, 'content-data');
  const collection = join(base, 'collection');
  await mkdir(join(collection, 'nes'), { recursive: true });
  const bytes = Buffer.from('generated-bytes');
  await writeFile(join(collection, 'nes', 'sample.nes'), bytes);

  const server = await openServer({ dataDir });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const owner = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    assert.equal(owner.statusCode, 201);
    const auth = { authorization: `Bearer ${(owner.json() as { token: string }).token}` };
    const library = await server.app.inject({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: auth,
      payload: { name: 'Shelf' },
    });
    assert.equal(library.statusCode, 201);
    const libraryId = (library.json() as { id: string }).id;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/roots',
      headers: auth,
      payload: { path: collection, label: 'Collection', libraryId },
    });
    assert.equal(created.statusCode, 201, created.body);
    const rootId = (created.json() as { id: string }).id;

    const scanned = await server.app.inject({
      method: 'POST',
      url: `/api/v1/roots/${rootId}/scan`,
      headers: auth,
    });
    assert.equal(scanned.statusCode, 200, scanned.body);
    const scan = scanned.json() as { online: boolean; count: number; medium: string };
    assert.equal(scan.online, true);
    assert.equal(scan.count, 1);

    const listed = await server.app.inject({
      method: 'GET',
      url: '/api/v1/sources',
      headers: auth,
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.equal(listed.body.includes(collection), false);
    const source = (listed.json() as { items: Array<Record<string, string>> }).items[0];
    assert.ok(source);
    assert.equal(source.name, 'sample.nes');
    assert.equal(source.kind, 'rom');
    assert.equal(source.systemId, 'com.provenance.nes');
    assert.equal(source.availability, 'local');
    assert.equal('path' in source, false);
    assert.equal(await readFile(join(collection, 'nes', 'sample.nes'), 'utf8'), 'generated-bytes');

    const content = await server.app.inject({
      method: 'GET',
      url: source.contentPath ?? '',
      headers: auth,
    });
    assert.equal(content.statusCode, 200, content.body);
    assert.equal(content.body, 'generated-bytes');

    const reader = await server.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: auth,
      payload: { username: 'reader', password: 'another-horse' },
    });
    assert.equal(reader.statusCode, 201);
    const readerId = (reader.json() as { id: string }).id;
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'reader', password: 'another-horse' },
    });
    const readerAuth = {
      authorization: `Bearer ${(login.json() as { token: string }).token}`,
    };
    const hidden = await server.app.inject({
      method: 'GET',
      url: '/api/v1/roots',
      headers: readerAuth,
    });
    assert.equal(hidden.statusCode, 403);
    const before = await server.app.inject({
      method: 'GET',
      url: '/api/v1/sources',
      headers: readerAuth,
    });
    assert.equal((before.json() as { items: unknown[] }).items.length, 0);
    const member = await server.app.inject({
      method: 'PUT',
      url: `/api/v1/libraries/${libraryId}/members/${readerId}`,
      headers: auth,
      payload: { role: 'reader' },
    });
    assert.equal(member.statusCode, 204, member.body);
    const shared = await server.app.inject({
      method: 'GET',
      url: '/api/v1/sources',
      headers: readerAuth,
    });
    assert.equal(shared.statusCode, 200, shared.body);
    assert.equal(shared.body.includes(collection), false);
    const sharedName = (shared.json() as { items: Array<{ name: string }> }).items[0]?.name;
    assert.equal(sharedName, 'sample.nes');

    await rm(collection, { recursive: true, force: true });
    const gone = await server.app.inject({
      method: 'GET',
      url: source.contentPath ?? '',
      headers: auth,
    });
    assert.equal(gone.statusCode, 503);
    assert.equal((gone.json() as { type: string }).type, 'urn:ecs:problem:source-offline');
    const roots = await server.app.inject({ method: 'GET', url: '/api/v1/roots', headers: auth });
    assert.equal((roots.json() as { items: unknown[] }).items.length, 1);
    const offline = await server.app.inject({
      method: 'GET',
      url: '/api/v1/sources',
      headers: auth,
    });
    const again = (offline.json() as { items: Array<{ availability: string }> }).items[0];
    assert.equal(again?.availability, 'offline');
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('a player can ask the file list for one BIOS file by kind and name', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ecs-bios-'));
  const dataDir = join(base, 'content-data');
  const collection = join(base, 'collection');
  await mkdir(join(collection, 'Naomi'), { recursive: true });
  await mkdir(join(collection, 'nes'), { recursive: true });
  await writeFile(join(collection, 'Naomi', 'naomi.zip'), Buffer.from('bios-bytes'));
  await writeFile(join(collection, 'Naomi', 'mvsc2.zip'), Buffer.from('game-bytes'));
  await writeFile(join(collection, 'nes', 'sample.nes'), Buffer.from('nes-bytes'));

  const server = await openServer({ dataDir });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const owner = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    assert.equal(owner.statusCode, 201);
    const auth = { authorization: `Bearer ${(owner.json() as { token: string }).token}` };
    const library = await server.app.inject({
      method: 'POST',
      url: '/api/v1/libraries',
      headers: auth,
      payload: { name: 'Shelf' },
    });
    const libraryId = (library.json() as { id: string }).id;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/roots',
      headers: auth,
      payload: { path: collection, label: 'Collection', libraryId },
    });
    assert.equal(created.statusCode, 201, created.body);
    const rootId = (created.json() as { id: string }).id;
    const scanned = await server.app.inject({
      method: 'POST',
      url: `/api/v1/roots/${rootId}/scan`,
      headers: auth,
    });
    assert.equal(scanned.statusCode, 200, scanned.body);

    type Listed = { items: Array<{ name: string; kind: string; contentPath: string }> };
    const list = async (query: string) => {
      const response = await server.app.inject({
        method: 'GET',
        url: `/api/v1/sources${query}`,
        headers: auth,
      });
      assert.equal(response.statusCode, 200, response.body);
      return (response.json() as Listed).items;
    };

    assert.equal((await list('')).length, 3);
    const bios = await list('?kind=bios');
    assert.deepEqual(
      bios.map((item) => [item.name, item.kind]),
      [['naomi.zip', 'bios']],
    );
    assert.equal((await list('?kind=bios&name=NAOMI.ZIP'))[0]?.name, 'naomi.zip');
    assert.equal((await list('?name=mvsc2.zip'))[0]?.kind, 'rom');
    assert.equal((await list('?kind=bios&name=awbios.zip')).length, 0);
    assert.equal((await list('?kind=rom&name=naomi.zip')).length, 0);

    const content = await server.app.inject({
      method: 'GET',
      url: bios[0]?.contentPath ?? '',
      headers: auth,
    });
    assert.equal(content.statusCode, 200);
    assert.equal(content.body, 'bios-bytes');

    const invalid = await server.app.inject({
      method: 'GET',
      url: '/api/v1/sources?kind=firmware',
      headers: auth,
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
