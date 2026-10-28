import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueToken } from '@ecs/auth';
import type { Actor, AssetKind } from '@ecs/domain';
import { openServer } from '../src/index.js';

export async function libraryFixture(options: { matchingPluginsDir?: string } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-browse-')));
  const server = await openServer({ dataDir: join(base, 'data'), ...options });
  const bootstrap = issueToken();
  server.catalog.saveBootstrapHash(bootstrap.hash);
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
  });
  const auth = { authorization: `Bearer ${response.json().token}` };
  const owner = server.catalog.listUsers()[0];
  if (!owner) throw new Error('Missing fixture owner');
  const library = server.catalog.createLibrary(owner.id, 'Shelf');
  const actor: Actor = {
    kind: 'user',
    userId: owner.id,
    username: 'owner',
    isOwner: true,
    tokenKind: 'session',
    deviceId: null,
    scopes: ['read', 'write', 'admin'],
  };
  const item = (title: string) =>
    server.catalog.createItem({
      libraryId: library.id,
      title,
      systemIdentifier: 'com.provenance.nes',
      md5: null,
      crc: null,
      actorId: owner.id,
    });
  const asset = (itemId: string, kind: AssetKind, shareable = true) =>
    server.catalog.completeUpload({
      uploadId: server.catalog.createUpload({
        userId: owner.id,
        guestGrantId: null,
        libraryId: library.id,
      }).id,
      itemId,
      kind,
      displayName: `${kind}.generated`,
      relativePath: `${kind}.generated`,
      baseRevision: server.catalog.getItem(itemId)?.revision ?? 1,
      sha256: 'a'.repeat(64),
      size: 1,
      md5: 'b'.repeat(32),
      crc: '12345678',
      shareable,
      actorId: owner.id,
      locationId: null,
    });
  return {
    ...server,
    base,
    auth,
    owner,
    actor,
    library,
    item,
    asset,
    async dispose() {
      await server.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}
