import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

export async function davFixture(enabled = true) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-dav-')));
  const dataDir = join(base, 'data');
  const sourceDir = join(base, 'sources');
  await mkdir(sourceDir);
  const server = await openServer({ dataDir, webdavEnabled: enabled });
  const token = issueToken();
  server.catalog.saveBootstrapHash(token.hash);
  const setup = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: {
      token: token.token,
      username: 'owner',
      password: 'correct-horse',
    },
  });
  assert.equal(setup.statusCode, 201);
  const session = setup.json() as { token: string; userId: string };
  const headers = { authorization: `Bearer ${session.token}` };
  const candidate = server.catalog.listLibraries(session.userId, true)[0];
  assert.ok(candidate);
  const library = candidate;
  const item = server.catalog.createItem({
    libraryId: library.id,
    systemIdentifier: 'com.provenance.nes',
    title: 'Game & <name>',
    md5: null,
    crc: null,
    actorId: session.userId,
    deviceId: null,
  });
  const bytes = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  async function upload(kind = 'rom', displayName = 'test.bin') {
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers,
      payload: { libraryId: library.id },
    });
    const id = (created.json() as { id: string }).id;
    assert.equal(created.statusCode, 201);
    const put = await server.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${id}/content`,
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-63/64`,
      },
      payload: bytes,
    });
    assert.equal(put.statusCode, 204);
    const result = await server.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${id}/complete`,
      headers,
      payload: {
        itemId: item.id,
        kind,
        displayName,
        relativePath: displayName,
        baseRevision: server.catalog.getItem(item.id)?.revision,
      },
    });
    assert.equal(result.statusCode, 201, 'fixture upload completed');
    return result.json() as { id: string; sha256: string };
  }
  const asset = await upload();
  const path = `/dav/libraries/${library.id}/${item.id}/${asset.id}--test.bin`;
  return {
    base,
    dataDir,
    sourceDir,
    server,
    headers,
    session,
    library,
    item,
    bytes,
    asset,
    path,
    upload,
    async source(relative = 'nested/ü & file.bin') {
      await mkdir(join(sourceDir, 'nested'), { recursive: true });
      await writeFile(join(sourceDir, relative), bytes);
      const root = server.catalog.createContentRoot({
        path: sourceDir,
        label: 'Source disk',
        libraryId: library.id,
        actorId: session.userId,
      });
      const scanned = await server.app.inject({
        method: 'POST',
        url: `/api/v1/roots/${root.id}/scan`,
        headers,
      });
      assert.equal(scanned.statusCode, 200);
      return root;
    },
    async close() {
      await server.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}
export function digestHeader(
  challenge: string,
  username: string,
  password: string,
  method: string,
  uri: string,
  count = 1,
  cnonce = 'independent-client',
): string {
  const fields = Object.fromEntries(
    [...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^, ]+))/g)].map((m) => [m[1], m[2] ?? m[3] ?? '']),
  );
  const hash = (value: string) =>
    createHash(fields.algorithm === 'SHA-256' ? 'sha256' : 'md5')
      .update(value)
      .digest('hex');
  const nc = count.toString(16).padStart(8, '0');
  const response = hash(
    `${hash(`${username}:${fields.realm}:${password}`)}:${fields.nonce}:${nc}:${cnonce}:auth:${hash(`${method}:${uri}`)}`,
  );
  return `Digest username="${username}", realm="${fields.realm}", nonce="${fields.nonce}", uri="${uri}", response="${response}", algorithm=${fields.algorithm}, qop=auth, nc=${nc}, cnonce="${cnonce}", opaque="${fields.opaque}"`;
}
