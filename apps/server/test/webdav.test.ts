import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';
import { issueToken } from '@ecs/auth';
import { blobPath } from '@ecs/storage';
import { davFixture, digestHeader } from './dav-fixture.js';

test('DAV opt-in capability and every method require credentials even with trusted sockets or tray Origin', async () => {
  for (const enabled of [false, true]) {
    const f = await davFixture(enabled);
    try {
      const cap = await f.server.app.inject('/api/v1/capabilities');
      assert.equal(cap.json().features.webdav, enabled);
      for (const method of ['OPTIONS', 'PROPFIND', 'GET'] as const) {
        const response = await f.server.app.inject({
          method: method as 'GET',
          url: '/dav/',
          headers: { origin: 'tauri://localhost', 'content-type': 'application/xml' },
          ...(method === 'PROPFIND' ? { payload: '<broken>' } : {}),
        });
        assert.equal(response.statusCode, enabled ? 401 : 404);
      }
    } finally {
      await f.close();
    }
  }
});
test('DAV bearer reads match REST ranges, conditionals, suffixes, HEAD and 416 over a real listener', async () => {
  const f = await davFixture();
  try {
    const origin = await f.server.app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { ...f.headers, range: 'bytes=13-28' };
    const dav = await fetch(origin + f.path, { headers });
    const rest = await fetch(`${origin}/api/v1/files/${f.asset.id}/content`, { headers });
    assert.equal(dav.status, 206);
    assert.equal(rest.status, 206);
    assert.deepEqual(Buffer.from(await dav.arrayBuffer()), f.bytes.subarray(13, 29));
    assert.deepEqual(Buffer.from(await rest.arrayBuffer()), f.bytes.subarray(13, 29));
    for (const header of ['etag', 'content-range', 'content-length', 'accept-ranges'])
      assert.equal(dav.headers.get(header), rest.headers.get(header));
    const head = await fetch(origin + f.path, { method: 'HEAD', headers });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-length'), '16');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const suffix = await fetch(origin + f.path, { headers: { ...f.headers, range: 'bytes=-3' } });
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), f.bytes.subarray(61));
    assert.equal(
      (await fetch(origin + f.path, { headers: { ...f.headers, range: 'bytes=64-' } })).status,
      416,
    );
    assert.equal(
      (
        await fetch(origin + f.path, {
          headers: { ...f.headers, 'if-none-match': dav.headers.get('etag') ?? '' },
        })
      ).status,
      304,
    );
    const entire = await fetch(origin + f.path, { headers: { ...headers, 'if-range': '"wrong"' } });
    assert.equal(entire.status, 200);
    await entire.arrayBuffer();
    const listing = await f.server.app.inject({
      method: 'PROPFIND' as 'GET',
      url: `/dav/libraries/${f.library.id}/${f.item.id}/`,
      headers: { ...f.headers, depth: '1' },
    });
    assert.equal(listing.statusCode, 207);
    assert.ok(listing.body.includes(f.asset.id));
    assert.equal(listing.body.includes(f.dataDir), false);
  } finally {
    await f.close();
  }
});
test('Digest authenticates both algorithms, enforces replay/URI/revocation, and never authenticates JSON API', async () => {
  const f = await davFixture();
  try {
    const create = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/webdav-credentials',
      headers: f.headers,
      payload: { name: 'Finder' },
    });
    const issued = create.json() as {
      credential: { id: string; username: string };
      password: string;
    };
    const initial = await f.server.app.inject({ method: 'OPTIONS', url: '/dav/' });
    const challenges = initial.headers['www-authenticate'];
    assert.ok(challenges);
    const list = (
      Array.isArray(challenges) ? challenges : challenges.split(/, (?=(?:Digest|Bearer) )/)
    ).filter((v) => /^Digest /.test(v));
    assert.equal(list.length, 2);
    for (const challenge of list) {
      const auth = digestHeader(
        challenge,
        issued.credential.username,
        issued.password,
        'PROPFIND',
        '/dav/',
        1,
        challenge.includes('algorithm=MD5') ? 'md5-client' : 'sha-client',
      );
      const headers = { authorization: auth, depth: '1' };
      assert.equal(
        (await f.server.app.inject({ method: 'PROPFIND' as 'GET', url: '/dav/', headers }))
          .statusCode,
        207,
      );
      assert.equal(
        (await f.server.app.inject({ method: 'PROPFIND' as 'GET', url: '/dav/', headers }))
          .statusCode,
        401,
      );
      assert.equal(
        (await f.server.app.inject({ method: 'GET', url: f.path, headers })).statusCode,
        401,
      );
      assert.equal(
        (await f.server.app.inject({ method: 'GET', url: '/api/v1/libraries', headers }))
          .statusCode,
        401,
      );
    }
    f.server.catalog.revokeWebDavCredential(issued.credential.id, f.session.userId);
    const auth = digestHeader(
      list[0] ?? '',
      issued.credential.username,
      issued.password,
      'GET',
      f.path,
      2,
    );
    assert.equal(
      (await f.server.app.inject({ method: 'GET', url: f.path, headers: { authorization: auth } }))
        .statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});
test('ACL listings and direct requests hide restricted guest assets and respect item-only user grants', async () => {
  const f = await davFixture();
  try {
    const bios = await f.upload('bios', 'firmware.bin');
    const guest = issueToken();
    f.server.catalog.createGuestGrant({
      tokenHash: guest.hash,
      libraryId: f.library.id,
      itemId: f.item.id,
      capabilities: ['read', 'share_restricted'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdBy: f.session.userId,
    });
    const headers = { authorization: `Bearer ${guest.token}`, depth: '1' };
    const list = await f.server.app.inject({
      method: 'PROPFIND' as 'GET',
      url: `/dav/libraries/${f.library.id}/${f.item.id}/`,
      headers,
    });
    assert.equal(list.statusCode, 207);
    assert.ok(list.body.includes(f.asset.id));
    assert.equal(list.body.includes(bios.id), false);
    assert.equal(
      (
        await f.server.app.inject({
          method: 'GET',
          url: `/dav/libraries/${f.library.id}/${f.item.id}/${bios.id}--firmware.bin`,
          headers,
        })
      ).statusCode,
      404,
    );
    const user = f.server.catalog.createUser({
      username: 'item-reader',
      passwordHash: 'fixture',
      actorId: f.session.userId,
    });
    f.server.catalog.setItemPermission(f.item.id, user.id, 'read', f.session.userId);
    const token = issueToken();
    f.server.catalog.createSession(user.id, token.hash);
    const userHeaders = { authorization: `Bearer ${token.token}`, depth: '1' };
    assert.equal(
      (await f.server.app.inject({ method: 'GET', url: f.path, headers: userHeaders })).statusCode,
      200,
    );
    const libraries = await f.server.app.inject({
      method: 'PROPFIND' as 'GET',
      url: '/dav/libraries/',
      headers: userHeaders,
    });
    assert.ok(libraries.body.includes(f.library.id));
    f.server.catalog.removeItemPermission(f.item.id, user.id, f.session.userId);
    assert.equal(
      (await f.server.app.inject({ method: 'GET', url: f.path, headers: userHeaders })).statusCode,
      404,
    );
    const sibling = f.server.catalog.createItem({
      libraryId: f.library.id,
      systemIdentifier: 'com.provenance.nes',
      title: 'Hidden sibling',
      md5: null,
      crc: null,
      actorId: f.session.userId,
    });
    const guestItems = await f.server.app.inject({
      method: 'PROPFIND' as 'GET',
      url: `/dav/libraries/${f.library.id}/`,
      headers,
    });
    assert.equal(guestItems.body.includes(sibling.id), false);
  } finally {
    await f.close();
  }
});
test('one item grant remains browseable in a library with over 10000 hidden items', async () => {
  const f = await davFixture();
  try {
    const db = new DatabaseSync(join(f.dataDir, 'library.sqlite'));
    try {
      db.exec('BEGIN');
      const insert = db.prepare(`INSERT INTO items
        (id, library_id, system_identifier, title, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)`);
      const now = new Date().toISOString();
      for (let i = 0; i < 10001; i++)
        insert.run(randomUUID(), f.library.id, 'com.provenance.nes', 'Hidden', now, now);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const user = f.server.catalog.createUser({
      username: 'single-grant',
      passwordHash: 'fixture',
      actorId: f.session.userId,
    });
    f.server.catalog.setItemPermission(f.item.id, user.id, 'read', f.session.userId);
    const token = issueToken();
    f.server.catalog.createSession(user.id, token.hash);
    let examined = 0;
    const original = f.server.catalog.listItems.bind(f.server.catalog);
    f.server.catalog.listItems = (input) => {
      const page = original(input);
      examined += page.items.length;
      return page;
    };
    const response = await f.server.app.inject({
      method: 'PROPFIND' as 'GET',
      url: `/dav/libraries/${f.library.id}/`,
      headers: { authorization: `Bearer ${token.token}`, depth: '1' },
    });
    assert.equal(response.statusCode, 207);
    assert.ok(response.body.includes(f.item.id));
    assert.equal(examined, 1);
    assert.equal((response.body.match(/<d:response>/g) ?? []).length, 2);
  } finally {
    await f.close();
  }
});
test('scanned sources preserve names and recheck disk presence without exposing absolute paths', async () => {
  const f = await davFixture();
  try {
    const root = await f.source();
    const path = `/dav/sources/${root.id}/nested/u%CC%88%20%26%20file.bin`;
    const get = await f.server.app.inject({
      method: 'GET',
      url: path,
      headers: { ...f.headers, range: 'bytes=10-20' },
    });
    assert.equal(get.statusCode, 206);
    assert.deepEqual(get.rawPayload, f.bytes.subarray(10, 21));
    const list = await f.server.app.inject({
      method: 'PROPFIND' as 'GET',
      url: `/dav/sources/${root.id}/nested/`,
      headers: { ...f.headers, depth: '1' },
    });
    assert.equal(list.statusCode, 207);
    assert.match(list.body, /%C3%BC%20%26%20file.bin/);
    assert.equal(list.body.includes(f.sourceDir), false);
    await rename(f.sourceDir, join(f.base, 'unplugged'));
    assert.equal(
      (await f.server.app.inject({ method: 'GET', url: path, headers: f.headers })).statusCode,
      503,
    );
  } finally {
    await f.close();
  }
});
test('registered source roots cannot be replaced by symlinks to outside bytes', async () => {
  const f = await davFixture();
  try {
    const root = await f.source();
    const source = f.server.catalog.listSources(root.id)[0];
    assert.ok(source);
    const outside = join(f.base, 'outside');
    await mkdir(join(outside, 'nested'), { recursive: true });
    await writeFile(join(outside, source.relativePath), Buffer.alloc(64, 255));
    await rename(f.sourceDir, join(f.base, 'original'));
    await symlink(outside, f.sourceDir, 'junction');
    for (const url of [
      `/dav/sources/${root.id}/nested/%C3%BC%20%26%20file.bin`,
      `/api/v1/sources/${source.id}/content`,
    ]) {
      const response = await f.server.app.inject({ url, headers: f.headers });
      assert.equal(response.statusCode, 404);
    }
  } finally {
    await f.close();
  }
});
test('source validators change on same-size edits and agree between DAV and REST', async () => {
  const f = await davFixture();
  try {
    const root = await f.source();
    const source = f.server.catalog.listSources(root.id)[0];
    assert.ok(source);
    const url = `/dav/sources/${root.id}/nested/%C3%BC%20%26%20file.bin`;
    const before = await f.server.app.inject({ url, headers: f.headers });
    const oldTag = String(before.headers.etag);
    const full = join(f.sourceDir, source.relativePath);
    const info = await stat(full);
    const changed = Buffer.alloc(64, 254);
    await writeFile(full, changed);
    await utimes(full, info.atime, new Date(info.mtimeMs + 2000));
    for (const path of [url, `/api/v1/sources/${source.id}/content`]) {
      const after = await f.server.app.inject({
        url: path,
        headers: { ...f.headers, 'if-none-match': oldTag },
      });
      assert.equal(after.statusCode, 200);
      assert.deepEqual(after.rawPayload, changed);
      assert.notEqual(after.headers.etag, oldTag);
      const currentTag = String(after.headers.etag);
      assert.match(currentTag, /^W\//);
      assert.equal(
        (
          await f.server.app.inject({
            url: path,
            headers: { ...f.headers, 'if-none-match': currentTag },
          })
        ).statusCode,
        304,
      );
      assert.equal(
        (
          await f.server.app.inject({
            url: path,
            headers: { ...f.headers, range: 'bytes=0-7', 'if-range': currentTag },
          })
        ).statusCode,
        200,
        'metadata validators cannot safely combine ranges',
      );
      const listing = await f.server.app.inject({
        method: 'PROPFIND' as 'GET',
        url,
        headers: { ...f.headers, depth: '0' },
      });
      assert.ok(listing.body.includes(currentTag.replaceAll('"', '&quot;')));
    }
  } finally {
    await f.close();
  }
});
test('source Depth-1 listings scan a bounded catalog once per request', async () => {
  const f = await davFixture();
  try {
    const root = await f.source();
    f.server.catalog.applyInspection({
      rootId: root.id,
      actorId: f.session.userId,
      online: true,
      files: Array.from({ length: 500 }, (_, i) => ({
        relativePath: `directory-${i}/file.bin`,
        displayName: 'file.bin',
        size: 64,
        blocks: 1,
        kind: 'rom',
        systemId: null,
        availability: 'local' as const,
      })),
    });
    let calls = 0;
    let rowLimit: number | undefined;
    assert.equal(f.server.catalog.listSources(root.id, 10).length, 10);
    assert.throws(() => f.server.catalog.listSources(root.id, 0));
    const original = f.server.catalog.listSources.bind(f.server.catalog);
    f.server.catalog.listSources = (id, ...limit: number[]) => {
      calls++;
      rowLimit = limit[0];
      return original(id, limit[0]);
    };
    const response = await f.server.app.inject({
      method: 'PROPFIND' as 'GET',
      url: `/dav/sources/${root.id}/`,
      headers: { ...f.headers, depth: '1' },
    });
    assert.equal(response.statusCode, 207);
    assert.equal((response.body.match(/<d:response>/g) ?? []).length, 501);
    assert.equal(calls, 1);
    assert.equal(rowLimit, 10001);
    f.server.catalog.applyInspection({
      rootId: root.id,
      actorId: f.session.userId,
      online: true,
      files: Array.from({ length: 10001 }, (_, i) => ({
        relativePath: `file-${i}.bin`,
        displayName: 'file.bin',
        size: 64,
        blocks: 1,
        kind: 'rom',
        systemId: null,
        availability: 'local' as const,
      })),
    });
    assert.equal(
      (
        await f.server.app.inject({
          method: 'PROPFIND' as 'GET',
          url: `/dav/sources/${root.id}/`,
          headers: { ...f.headers, depth: '1' },
        })
      ).statusCode,
      507,
    );
  } finally {
    await f.close();
  }
});
test('mutations, malformed XML and escaping paths cannot change or escape content', async (t) => {
  const f = await davFixture();
  try {
    for (const method of [
      'PUT',
      'DELETE',
      'MKCOL',
      'COPY',
      'MOVE',
      'PROPPATCH',
      'LOCK',
      'UNLOCK',
    ] as const)
      assert.equal(
        (await f.server.app.inject({ method: method as 'GET', url: f.path, headers: f.headers }))
          .statusCode,
        405,
      );
    const origin = await f.server.app.listen({ host: '127.0.0.1', port: 0 });
    for (const path of [
      '/dav/../bootstrap.token',
      '/dav/%2e%2e/bootstrap.token',
      '/dav/x%2Fy',
      '/dav/%252e%252e',
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: '127.0.0.1',
            port: new URL(origin).port,
            path,
            method: 'GET',
            headers: f.headers,
          },
          (response) => {
            response.resume();
            response.on('end', () => resolve(response.statusCode ?? 0));
          },
        );
        request.on('error', reject);
        request.end();
      });
      assert.equal(status, 400);
    }
    const bad = await f.server.app.inject({
      method: 'PROPFIND' as 'GET',
      url: '/dav/',
      headers: { ...f.headers, depth: '0', 'content-type': 'application/xml' },
      payload: '<!DOCTYPE x><propfind/>',
    });
    assert.equal(bad.statusCode, 400);
    const large = await f.server.app.inject({
      method: 'PROPFIND' as 'GET',
      url: '/dav/',
      headers: { ...f.headers, depth: '0', 'content-type': 'application/xml' },
      payload: 'x'.repeat(32769),
    });
    assert.equal(large.statusCode, 413);
    const physical = blobPath(f.dataDir, f.asset.sha256);
    const outside = join(f.base, 'outside');
    await writeFile(outside, f.bytes);
    await rm(physical);
    try {
      await symlink(outside, physical);
    } catch (error) {
      if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        t.diagnostic('Symlink creation unavailable on Windows');
        return;
      }
      throw error;
    }
    assert.equal(
      (await f.server.app.inject({ method: 'GET', url: f.path, headers: f.headers })).statusCode,
      404,
    );
    assert.equal(
      (
        await f.server.app.inject({
          method: 'GET',
          url: `/api/v1/files/${f.asset.id}/content`,
          headers: f.headers,
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});
test('real curl Digest client can browse with a generated app password', async (t) => {
  try {
    const version = await promisify(execFile)('curl', ['--version']);
    if (process.platform === 'win32' && /\bSSPI\b/.test(version.stdout)) {
      // https://curl.se/docs/knownbugs.html#SHA_256_digest_not_supported_in
      t.skip(
        'Windows SSPI curl lacks SHA-256 Digest; independent client tests cover both algorithms',
      );
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      t.skip('curl unavailable');
      return;
    }
    throw error;
  }
  const f = await davFixture();
  try {
    const created = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/webdav-credentials',
      headers: f.headers,
      payload: { name: 'curl' },
    });
    const issued = created.json();
    const origin = await f.server.app.listen({ host: '127.0.0.1', port: 0 });
    const config = join(f.base, 'curl-config');
    await writeFile(
      config,
      `silent\nshow-error\ndigest\nuser = "${issued.credential.username}:${issued.password}"\nurl = "${origin}/dav/"\nrequest = "PROPFIND"\nheader = "Depth: 1"\nwrite-out = "\\n%{http_code}"\n`,
      { mode: 0o600 },
    );
    try {
      const result = await promisify(execFile)('curl', ['--config', config], { timeout: 30_000 });
      assert.match(result.stdout, /<d:multistatus/);
      assert.match(result.stdout, /207$/);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') t.skip('curl unavailable');
      else throw error;
    } finally {
      await rm(config);
    }
  } finally {
    await f.close();
  }
});

test('DAV collections include later catalog pages and apply membership changes immediately', async () => {
  const f = await davFixture();
  try {
    for (let i = 0; i < 125; i++)
      f.server.catalog.createItem({
        libraryId: f.library.id,
        systemIdentifier: 'com.provenance.nes',
        title: `Generated ${i}`,
        md5: null,
        crc: null,
        actorId: f.session.userId,
      });
    const listing = await f.server.app.inject({
      method: 'PROPFIND' as 'GET',
      url: `/dav/libraries/${f.library.id}/`,
      headers: { ...f.headers, depth: '1' },
    });
    assert.equal(listing.statusCode, 207);
    assert.equal((listing.body.match(/<d:response>/g) ?? []).length, 127);
    const user = f.server.catalog.createUser({
      username: 'member',
      passwordHash: 'fixture',
      actorId: f.session.userId,
    });
    f.server.catalog.setMember(f.library.id, user.id, 'reader', f.session.userId);
    const token = issueToken();
    f.server.catalog.createSession(user.id, token.hash);
    const headers = { authorization: `Bearer ${token.token}` };
    for (let i = 0; i < 12; i++)
      assert.equal(
        (await f.server.app.inject({ method: 'GET', url: f.path, headers })).statusCode,
        200,
      );
    f.server.catalog.removeMember(f.library.id, user.id, f.session.userId);
    assert.equal(
      (await f.server.app.inject({ method: 'GET', url: f.path, headers })).statusCode,
      404,
    );
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await f.server.app.inject({
            method: 'GET',
            url: f.path,
            headers: { authorization: 'Bearer bad' },
          })
        ).statusCode,
        401,
      );
    assert.equal(
      (
        await f.server.app.inject({
          method: 'GET',
          url: f.path,
          headers: { authorization: 'Bearer bad' },
        })
      ).statusCode,
      429,
    );
    assert.equal(
      (await f.server.app.inject({ method: 'GET', url: f.path, headers: f.headers })).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});
test('secondary bytes use the same range reader and report an unplugged location', async () => {
  const f = await davFixture();
  try {
    const extra = join(f.base, 'extra');
    await mkdir(extra);
    const created = await f.server.app.inject({
      method: 'POST',
      url: '/api/v1/storage-locations',
      headers: f.headers,
      payload: { path: extra, label: 'Extra' },
    });
    assert.equal(created.statusCode, 201);
    f.server.catalog.setWriteLocation(created.json().id, f.session.userId);
    f.bytes[0] = 254;
    const asset = await f.upload('rom', 'second.bin');
    const path = `/dav/libraries/${f.library.id}/${f.item.id}/${asset.id}--second.bin`;
    const content = await f.server.app.inject({
      method: 'GET',
      url: path,
      headers: { ...f.headers, range: 'bytes=0-4' },
    });
    assert.equal(content.statusCode, 206);
    assert.deepEqual(content.rawPayload, f.bytes.subarray(0, 5));
    await rename(extra, join(f.base, 'offline-extra'));
    const outside = join(f.base, 'outside-storage');
    const { dirname } = await import('node:path');
    const outsideBlob = blobPath(outside, asset.sha256);
    await mkdir(dirname(outsideBlob), { recursive: true });
    await writeFile(outsideBlob, Buffer.alloc(64, 253));
    await symlink(outside, extra, 'junction');
    for (const url of [path, `/api/v1/files/${asset.id}/content`]) {
      assert.equal((await f.server.app.inject({ url, headers: f.headers })).statusCode, 404);
    }
    await rm(extra);
    assert.equal(
      (await f.server.app.inject({ method: 'GET', url: path, headers: f.headers })).statusCode,
      503,
    );
    assert.equal(
      (await f.server.app.inject({ method: 'GET', url: f.path, headers: f.headers })).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});
test('source metadata is usable by Finder and placeholder reads never open bytes', async (t) => {
  const f = await davFixture();
  try {
    const root = await f.source();
    const props = await f.server.app.inject({
      method: 'PROPFIND' as 'GET',
      url: `/dav/sources/${root.id}/nested/%C3%BC%20%26%20file.bin`,
      headers: { ...f.headers, depth: '0', 'content-type': 'application/xml' },
      payload:
        '<d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>',
    });
    assert.equal(props.statusCode, 207);
    assert.match(props.body, /GMT<\/d:getlastmodified>/);
    assert.doesNotMatch(props.body, /404 Not Found/);
    const cloud = join(f.base, 'Library', 'CloudStorage', 'Fixture');
    await mkdir(cloud, { recursive: true });
    const placeholder = join(cloud, 'generated.bin');
    await writeFile(placeholder, Buffer.alloc(0));
    const { truncate, stat } = await import('node:fs/promises');
    await truncate(placeholder, 4096);
    if ((await stat(placeholder)).blocks !== 0) {
      t.diagnostic('Sparse placeholders unavailable on this platform');
      return;
    }
    const saved = f.server.catalog.createContentRoot({
      path: cloud,
      label: 'Cloud fixture',
      libraryId: f.library.id,
      actorId: f.session.userId,
    });
    await f.server.app.inject({
      method: 'POST',
      url: `/api/v1/roots/${saved.id}/scan`,
      headers: f.headers,
    });
    const response = await f.server.app.inject({
      method: 'GET',
      url: `/dav/sources/${saved.id}/generated.bin`,
      headers: f.headers,
    });
    assert.equal(response.statusCode, 409);
    assert.equal((await stat(placeholder)).blocks, 0);
  } finally {
    await f.close();
  }
});

test('ambiguous scanned names are refused and item-scoped guests cannot browse source roots', async () => {
  const f = await davFixture();
  try {
    const root = await f.source();
    const guest = issueToken();
    f.server.catalog.createGuestGrant({
      tokenHash: guest.hash,
      libraryId: f.library.id,
      itemId: f.item.id,
      capabilities: ['read'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdBy: f.session.userId,
    });
    const guestHeaders = { authorization: `Bearer ${guest.token}`, depth: '1' };
    const hidden = await f.server.app.inject({
      method: 'PROPFIND' as 'GET',
      url: '/dav/sources/',
      headers: guestHeaders,
    });
    assert.equal(hidden.statusCode, 207);
    assert.equal(hidden.body.includes(root.id), false);
    assert.equal(
      (
        await f.server.app.inject({
          method: 'GET',
          url: `/dav/sources/${root.id}/nested/%C3%BC%20%26%20file.bin`,
          headers: guestHeaders,
        })
      ).statusCode,
      404,
    );
    const record = {
      displayName: 'ambiguous',
      size: 1,
      blocks: 1,
      kind: 'rom',
      systemId: null,
      availability: 'local' as const,
    };
    for (const paths of [
      ['same', 'same/child'],
      ['ü.bin', 'u\u0308.bin'],
    ]) {
      f.server.catalog.applyInspection({
        rootId: root.id,
        actorId: f.session.userId,
        online: true,
        files: paths.map((relativePath) => ({ ...record, relativePath })),
      });
      assert.equal(
        (
          await f.server.app.inject({
            method: 'PROPFIND' as 'GET',
            url: `/dav/sources/${root.id}/`,
            headers: { ...f.headers, depth: '1' },
          })
        ).statusCode,
        409,
      );
    }
  } finally {
    await f.close();
  }
});
test('empty catalog files preserve zero content length and unsatisfiable ranges', async () => {
  const f = await davFixture();
  try {
    const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const { dirname } = await import('node:path');
    await mkdir(dirname(blobPath(f.dataDir, sha256)), { recursive: true });
    await writeFile(blobPath(f.dataDir, sha256), Buffer.alloc(0));
    const upload = f.server.catalog.createUpload({
      userId: f.session.userId,
      guestGrantId: null,
      libraryId: f.library.id,
    });
    const asset = f.server.catalog.completeUpload({
      uploadId: upload.id,
      itemId: f.item.id,
      kind: 'rom',
      displayName: 'empty.bin',
      relativePath: 'empty.bin',
      baseRevision: f.server.catalog.getItem(f.item.id)?.revision ?? 0,
      sha256,
      size: 0,
      md5: 'd41d8cd98f00b204e9800998ecf8427e',
      crc: '00000000',
      shareable: true,
      actorId: f.session.userId,
      deviceId: null,
      locationId: null,
    });
    const path = `/dav/libraries/${f.library.id}/${f.item.id}/${asset.id}--empty.bin`;
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await f.server.app.inject({ method, url: path, headers: f.headers });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-length'], '0');
      assert.equal(response.rawPayload.length, 0);
    }
    const range = await f.server.app.inject({
      method: 'GET',
      url: path,
      headers: { ...f.headers, range: 'bytes=0-' },
    });
    assert.equal(range.statusCode, 416);
    assert.equal(range.headers['content-range'], 'bytes */0');
  } finally {
    await f.close();
  }
});
