import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { issueToken } from '@ecs/auth';
import { crc32Hex } from '@ecs/storage';
import { openServer } from '../src/index.js';

interface Member {
  name: string;
  body: Buffer;
  compress?: boolean;
}

function buildZip(members: Member[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const payload = member.compress ? deflateRawSync(member.body) : member.body;
    const method = member.compress ? 8 : 0;
    const crc = Number.parseInt(crc32Hex(member.body), 16);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(member.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, payload);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(member.body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('archive entries are listed and served as byte ranges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-entries-'));
  const server = await openServer({
    dataDir: dir,
    limits: { maxUploadBytes: 1024 * 1024, maxLibraryBytes: 4 * 1024 * 1024 },
  });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const owner = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    const auth = { authorization: `Bearer ${(owner.json() as { token: string }).token}` };
    const libraries = await server.app.inject({
      method: 'GET',
      url: '/api/v1/libraries',
      headers: auth,
    });
    const libraryId = (libraries.json() as { items: Array<{ id: string }> }).items[0]?.id;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: auth,
      payload: { libraryId, systemIdentifier: 'com.provenance.psx', title: 'Archive Demo' },
    });
    const item = created.json() as { id: string };

    const stored = randomBytes(4096);
    const deflated = Buffer.concat([randomBytes(1024), Buffer.alloc(1024, 3)]);
    const archive = buildZip([
      { name: 'disc.bin', body: stored },
      { name: 'notes.txt', body: deflated, compress: true },
    ]);

    const upload = async (kind: string, name: string): Promise<string> => {
      const session = await server.app.inject({
        method: 'POST',
        url: '/api/v1/uploads',
        headers: auth,
        payload: { libraryId },
      });
      const uploadId = (session.json() as { id: string }).id;
      await server.app.inject({
        method: 'PUT',
        url: `/api/v1/uploads/${uploadId}/content`,
        headers: { ...auth, 'content-type': 'application/octet-stream' },
        payload: archive,
      });
      const current = await server.app.inject({
        method: 'GET',
        url: `/api/v1/items/${item.id}`,
        headers: auth,
      });
      const committed = await server.app.inject({
        method: 'POST',
        url: `/api/v1/uploads/${uploadId}/complete`,
        headers: auth,
        payload: {
          itemId: item.id,
          kind,
          displayName: name,
          relativePath: name,
          baseRevision: (current.json() as { revision: number }).revision,
        },
      });
      assert.equal(committed.statusCode, 201);
      return (committed.json() as { id: string }).id;
    };

    const romId = await upload('rom', 'disc.zip');

    const listed = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${romId}/entries`,
      headers: auth,
    });
    assert.equal(listed.statusCode, 200);
    const body = listed.json() as {
      supported: boolean;
      entries: string[];
      format: string | null;
      items: Array<{ entryId: string; method: string; uncompressedSize: number }>;
    };
    assert.equal(body.supported, true);
    assert.equal(body.format, 'zip');
    assert.deepEqual(body.entries, ['disc.bin', 'notes.txt']);
    assert.deepEqual(
      body.items.map((entry) => [entry.entryId, entry.method, entry.uncompressedSize]),
      [
        ['0', 'store', stored.length],
        ['1', 'deflate', deflated.length],
      ],
    );

    const ranged = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${romId}/entries/0/content`,
      headers: { ...auth, range: 'bytes=1000-1099' },
    });
    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.headers['content-range'], `bytes 1000-1099/${stored.length}`);
    assert.deepEqual(ranged.rawPayload, stored.subarray(1000, 1100));

    const head = await server.app.inject({
      method: 'HEAD',
      url: `/api/v1/files/${romId}/entries/0/content`,
      headers: auth,
    });
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers['accept-ranges'], 'bytes');
    assert.equal(head.headers['content-length'], String(stored.length));

    const expanded = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${romId}/entries/1/content`,
      headers: { ...auth, range: 'bytes=1500-1599' },
    });
    assert.equal(expanded.statusCode, 206);
    assert.deepEqual(expanded.rawPayload, deflated.subarray(1500, 1600));

    const beyond = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${romId}/entries/0/content`,
      headers: { ...auth, range: `bytes=${stored.length}-` },
    });
    assert.equal(beyond.statusCode, 416);
    assert.equal(beyond.headers['content-range'], `bytes */${stored.length}`);

    const missing = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${romId}/entries/9/content`,
      headers: auth,
    });
    assert.equal(missing.statusCode, 404);

    const biosId = await upload('bios', 'bios.zip');
    const guest = await server.app.inject({
      method: 'POST',
      url: '/api/v1/guest-grants',
      headers: auth,
      payload: { libraryId, capabilities: ['read'], expiresInSeconds: 3600 },
    });
    const guestAuth = {
      authorization: `Bearer ${(guest.json() as { token: string }).token}`,
    };
    const guestRom = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${romId}/entries/0/content`,
      headers: guestAuth,
    });
    assert.equal(guestRom.statusCode, 200);
    const guestBios = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${biosId}/entries/0/content`,
      headers: guestAuth,
    });
    assert.equal(guestBios.statusCode, 403);
    const guestBiosList = await server.app.inject({
      method: 'GET',
      url: `/api/v1/files/${biosId}/entries`,
      headers: guestAuth,
    });
    assert.equal(guestBiosList.statusCode, 403);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
