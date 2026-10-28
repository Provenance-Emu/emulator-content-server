import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { hashToken } from '@ecs/auth';
import { DomainError } from '@ecs/domain';
import Fastify from 'fastify';
import type { ServerContext } from '../src/context.js';
import { registerLibraryJobs } from '../src/library-jobs.js';
import { libraryFixture } from './library-fixture.js';

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Shared job did not settle');
    await pause(5);
  }
}

test('shared jobs reuse work across owner sessions, serialize sources, and cancel independently of the starting connection', async () => {
  const f = await libraryFixture();
  const app = Fastify();
  let started = 0;
  let stopped = 0;
  let resolveStarted: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  try {
    const root = f.catalog.createContentRoot({
      path: f.base,
      label: 'Generated',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    f.catalog.applyInspection({
      rootId: root.id,
      actorId: f.owner.id,
      online: true,
      files: Array.from({ length: 1000 }, (_, i) => ({
        relativePath: `Generated-${i}.nes`,
        displayName: `Generated-${i}.nes`,
        kind: 'rom',
        systemId: null,
        size: 4,
        blocks: 1,
        availability: 'local' as const,
      })),
    });
    app.decorateRequest('actor', null);
    app.addHook('onRequest', async (request) => {
      const authorization = request.headers.authorization;
      request.actor = authorization?.startsWith('Bearer ')
        ? f.catalog.authenticate(hashToken(authorization.slice(7)))
        : null;
    });
    app.setErrorHandler((error, _request, reply) => {
      reply
        .code(error instanceof DomainError ? error.status : 500)
        .send({ error: error instanceof Error ? error.message : 'Unknown error' });
    });
    registerLibraryJobs(app, { catalog: f.catalog } as ServerContext, {
      async autoMatch(_actor, _source, _options, signal) {
        started++;
        resolveStarted();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              stopped++;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
        return { status: 'unmatched', saved: 0, suggestions: 0, error: null };
      },
    });
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/library-jobs',
      headers: f.auth,
      payload: { kind: 'match', libraryId: f.library.id },
    });
    assert.equal(first.statusCode, 202, first.body);
    const id = first.json().job.id;
    await firstStarted;
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'owner', password: 'correct-horse' },
    });
    assert.equal(login.statusCode, 200, login.body);
    const secondAuth = { authorization: `Bearer ${login.json().token}` };
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/library-jobs',
      headers: secondAuth,
      payload: { kind: 'match', rootId: root.id },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().job.id, id);
    assert.equal(second.json().reused, true);
    assert.equal(second.json().job.total, 1000);
    assert.equal(started, 1);
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/library-jobs/${id}/cancel`,
      headers: secondAuth,
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().job.state, 'cancelled');
    await eventually(() => stopped === 1);
    assert.equal(started, 1);
    const list = await app.inject({ url: '/api/v1/library-jobs', headers: f.auth });
    assert.equal(list.json().jobs[0].id, id);
    const page = await app.inject({
      url: `/api/v1/library-jobs/${id}/items?limit=2`,
      headers: secondAuth,
    });
    assert.equal(page.json().items.length, 2);
    assert.ok(page.json().nextCursor);
    assert.ok(page.json().items[0].source.name);
    assert.ok(!page.body.includes('relativePath'));
    assert.ok(!page.body.includes(f.base));
    const next = await app.inject({
      url: `/api/v1/library-jobs/${id}/items?limit=2&cursor=${page.json().nextCursor}`,
      headers: secondAuth,
    });
    assert.notEqual(next.json().items[0].sourceId, page.json().items[0].sourceId);
    const denied = await app.inject({ method: 'POST', url: `/api/v1/library-jobs/${id}/cancel` });
    assert.equal(denied.statusCode, 401);
  } finally {
    await app.close();
    await f.dispose();
  }
});

test('shared matching is checksum-only, preserves saved categories, and leaves filename hints for review', async () => {
  const f = await libraryFixture();
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const path = join(f.base, 'generated');
    await mkdir(path);
    await writeFile(join(path, 'Generated.nes'), Buffer.from([1, 2, 3, 4]));
    await writeFile(join(path, 'Generated.json'), JSON.stringify({ title: 'Filename hint' }));
    const root = f.catalog.createContentRoot({
      path,
      label: 'Generated',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    const scan = await f.app.inject({
      method: 'POST',
      url: `/api/v1/roots/${root.id}/scan`,
      headers: f.auth,
    });
    assert.equal(scan.statusCode, 200, scan.body);
    const source = f.catalog.listSources(root.id).find((source) => source.kind === 'rom');
    assert.ok(source);
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/v1/library-jobs',
      headers: f.auth,
      payload: {
        kind: 'match',
        rootId: root.id,
        options: { checksum: true, providerIds: ['org.ecs.local'] },
      },
    });
    assert.equal(created.statusCode, 202, created.body);
    await eventually(() => f.catalog.libraryJobs.get(created.json().job.id)?.state === 'completed');
    const job = f.catalog.libraryJobs.get(created.json().job.id);
    assert.equal(job?.review, 1);
    assert.equal(job?.saved, 0);
    assert.equal(job?.processed, 1);
    assert.deepEqual(f.catalog.sourceMatches(source.id).matches, []);
    const reviewed = await f.app.inject({
      method: 'POST',
      url: `/api/v1/library-jobs/${created.json().job.id}/items/${source.id}/reviewed`,
      headers: f.auth,
    });
    assert.equal(reviewed.statusCode, 200, reviewed.body);
    assert.equal(reviewed.json().job.review, 0);
    assert.equal(reviewed.json().job.processed, 1);
    const repeated = await f.app.inject({
      method: 'POST',
      url: `/api/v1/library-jobs/${created.json().job.id}/items/${source.id}/reviewed`,
      headers: f.auth,
    });
    assert.equal(repeated.json().job.review, 0);
    const remaining = await f.app.inject({
      url: `/api/v1/library-jobs/${created.json().job.id}/items?status=review`,
      headers: f.auth,
    });
    assert.equal(remaining.json().items.length, 0);
    assert.deepEqual(f.catalog.sourceMatches(source.id).matches, []);
  } finally {
    await f.dispose();
  }
});

test('a disconnected job creation request leaves server work running until explicit cancellation or completion', async () => {
  const f = await libraryFixture();
  const app = Fastify();
  let release: () => void = () => {};
  let began: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let aborted = false;
  try {
    const root = f.catalog.createContentRoot({
      path: f.base,
      label: 'Generated',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    f.catalog.applyInspection({
      rootId: root.id,
      actorId: f.owner.id,
      online: true,
      files: [
        {
          relativePath: 'Generated.nes',
          displayName: 'Generated.nes',
          kind: 'rom',
          systemId: null,
          size: 4,
          blocks: 1,
          availability: 'local',
        },
      ],
    });
    app.decorateRequest('actor', null);
    app.addHook('onRequest', async (request) => {
      request.actor = f.actor;
    });
    app.addHook('onSend', async (request, _reply, payload) => {
      if (request.method === 'POST' && request.url === '/api/v1/library-jobs') {
        await started;
        await pause(50);
      }
      return payload;
    });
    registerLibraryJobs(app, { catalog: f.catalog } as ServerContext, {
      async autoMatch(_actor, _source, _options, signal) {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
          },
          { once: true },
        );
        began();
        await gate;
        signal.throwIfAborted();
        return { status: 'unmatched', saved: 0, suggestions: 0, error: null };
      },
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const response = fetch(`${address}/api/v1/library-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'match', rootId: root.id }),
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await assert.rejects(response, { name: 'AbortError' });
    await pause(20);
    assert.equal(aborted, false);
    const job = f.catalog.libraryJobs.list(1)[0];
    assert.ok(job);
    assert.equal(job.state, 'running');
    release();
    await eventually(() => f.catalog.libraryJobs.get(job.id)?.state === 'completed');
    assert.equal(aborted, false);
    assert.equal(f.catalog.libraryJobs.get(job.id)?.processed, 1);
  } finally {
    release();
    await app.close();
    await f.dispose();
  }
});

test('automatic matching saves a unique checksum patch, preserves saved metadata, and leaves ambiguous checksum alternatives for review', async () => {
  const f = await libraryFixture();
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { crc32 } = await import('node:zlib');
    const path = join(f.base, 'generated');
    await mkdir(path);
    await mkdir(join(path, 'unique'));
    await mkdir(join(path, 'ambiguous'));
    const bytes = Buffer.from([1, 2, 3, 4]);
    const patch = Buffer.concat([
      Buffer.from('BPS1'),
      Buffer.from([0x84, 0x85, 0x80]),
      Buffer.alloc(12),
    ]);
    patch.writeUInt32LE(crc32(bytes), patch.length - 12);
    patch.writeUInt32LE(crc32(patch.subarray(0, -4)), patch.length - 4);
    for (const folder of ['unique', 'ambiguous']) {
      await writeFile(join(path, folder, 'Generated.nes'), bytes);
      await writeFile(join(path, folder, 'Translation.bps'), patch);
    }
    await writeFile(join(path, 'ambiguous', 'Alternative.bps'), patch);
    const root = f.catalog.createContentRoot({
      path,
      label: 'Generated',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    const scan = await f.app.inject({
      method: 'POST',
      url: `/api/v1/roots/${root.id}/scan`,
      headers: f.auth,
    });
    assert.equal(scan.statusCode, 200, scan.body);
    const unique = f.catalog
      .listSources(root.id)
      .find((source) => source.relativePath === 'unique/Generated.nes');
    const ambiguous = f.catalog
      .listSources(root.id)
      .find((source) => source.relativePath === 'ambiguous/Generated.nes');
    assert.ok(unique);
    assert.ok(ambiguous);
    f.catalog.saveSourceMatch(
      unique.id,
      0,
      'metadata',
      {
        id: 'existing-choice',
        providerId: 'org.ecs.local',
        kind: 'metadata',
        title: 'Keep this choice',
        confidence: 'name',
        metadata: { title: 'Keep this choice' },
        originKind: null,
        contentAvailable: false,
        contentType: null,
        fileName: null,
        updatedAt: new Date().toISOString(),
      },
      null,
      f.owner.id,
    );
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/v1/library-jobs',
      headers: f.auth,
      payload: {
        kind: 'match',
        rootId: root.id,
        options: { checksum: true, providerIds: ['org.ecs.local'] },
      },
    });
    assert.equal(response.statusCode, 202, response.body);
    await eventually(
      () => f.catalog.libraryJobs.get(response.json().job.id)?.state === 'completed',
    );
    const saved = f.catalog.sourceMatches(unique.id).matches;
    assert.equal(saved.find((match) => match.kind === 'metadata')?.id, 'existing-choice');
    assert.equal(saved.filter((match) => match.kind === 'patch').length, 1);
    assert.equal(f.catalog.sourceMatches(ambiguous.id).matches.length, 0);
    const job = f.catalog.libraryJobs.get(response.json().job.id);
    assert.equal(job?.saved, 1);
    assert.equal(job?.review, 1);
    assert.equal(job?.processed, 2);
  } finally {
    await f.dispose();
  }
});

test('concurrent matching lookups share one proposal and unchanged source checksums use the catalog cache', async () => {
  const f = await libraryFixture();
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const path = join(f.base, 'generated');
    await mkdir(path);
    await writeFile(join(path, 'Generated.nes'), Buffer.from([1, 2, 3, 4]));
    const root = f.catalog.createContentRoot({
      path,
      label: 'Generated',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(root.id)[0];
    assert.ok(source);
    let hits = 0;
    let misses = 0;
    const read = f.catalog.matchingIdentification.bind(f.catalog);
    f.catalog.matchingIdentification = (id, stamp) => {
      const result = read(id, stamp);
      if (result) hits++;
      else misses++;
      return result;
    };
    const request = () =>
      f.app.inject({
        method: 'POST',
        url: `/api/v1/sources/${source.id}/matches`,
        headers: f.auth,
        payload: { checksum: true, providerIds: ['org.ecs.local'] },
      });
    const [first, second] = await Promise.all([request(), request()]);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(first.json().requestId, second.json().requestId);
    assert.equal(misses, 1);
    assert.equal(hits, 0);
    assert.equal((await request()).statusCode, 200);
    assert.equal(hits, 1);
    assert.equal(misses, 1);
    await writeFile(join(path, 'Generated.nes'), Buffer.from([4, 3, 2, 1]));
    assert.equal((await request()).statusCode, 200);
    assert.equal(hits, 1);
    assert.equal(misses, 2);
  } finally {
    await f.dispose();
  }
});
