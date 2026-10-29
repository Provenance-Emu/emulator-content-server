import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { DomainError } from '@ecs/domain';
import Fastify from 'fastify';
import type { ServerContext } from '../src/context.js';
import { enqueueRootScan, registerLibraryJobs } from '../src/library-jobs.js';
import { libraryFixture } from './library-fixture.js';

const diskFull = () => Object.assign(new Error('database or disk is full'), { errcode: 13 });

async function fixture() {
  const f = await libraryFixture();
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
    files: [0, 1].map((i) => ({
      relativePath: `Generated-${i}.nes`,
      displayName: `Generated-${i}.nes`,
      kind: 'rom',
      systemId: 'com.provenance.nes',
      size: 4,
      blocks: 1,
      availability: 'local' as const,
    })),
  });
  const app = Fastify();
  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (request) => {
    request.actor = f.actor;
  });
  app.setErrorHandler((error, _request, reply) => {
    reply
      .code(error instanceof DomainError ? error.status : 500)
      .send({ error: error instanceof Error ? error.message : 'Unknown error' });
  });
  return { ...f, worker: app, root };
}

async function settled(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'Worker did not settle');
    await pause(5);
  }
  await pause(10);
}

test('disk-full outcome and status writes leave pending work resumable without losing completed outcomes', async () => {
  const f = await fixture();
  const repository = f.catalog.libraryJobs;
  const finish = repository.finishItem.bind(repository);
  const state = repository.state.bind(repository);
  let full = false;
  let attempts = 0;
  const matched: string[] = [];
  try {
    repository.finishItem = (id, item) => {
      if (++attempts === 2 || full) {
        full = true;
        throw diskFull();
      }
      finish(id, item);
    };
    repository.state = (id, status, error) => {
      if (full) throw diskFull();
      return state(id, status, error);
    };
    registerLibraryJobs(f.worker, { catalog: f.catalog } as ServerContext, {
      async autoMatch(_actor, sourceId) {
        matched.push(sourceId);
        return { status: 'unmatched', saved: 0, suggestions: 0, error: null };
      },
    });
    const created = await f.worker.inject({
      method: 'POST',
      url: '/api/v1/library-jobs',
      payload: { kind: 'match', rootId: f.root.id },
    });
    assert.equal(created.statusCode, 202, created.body);
    const id = created.json().job.id;
    await settled(() => full);
    const read = await f.worker.inject({ url: `/api/v1/library-jobs/${id}` });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json().job.state, 'interrupted');
    assert.match(read.json().job.error, /storage|disk/i);
    assert.equal(read.json().job.processed, 1);
    assert.equal(read.json().job.failed, 0);
    const list = await f.worker.inject({ url: '/api/v1/library-jobs' });
    assert.equal(list.json().jobs[0].state, 'interrupted');
    await pause(30);
    assert.equal(matched.length, 2, 'No hot retry on an unwritable disk');
    const blockedResume = await f.worker.inject({
      method: 'POST',
      url: `/api/v1/library-jobs/${id}/resume`,
    });
    assert.equal(blockedResume.statusCode, 503);
    assert.equal(matched.length, 2);
    full = false;
    repository.finishItem = finish;
    const resumed = await f.worker.inject({
      method: 'POST',
      url: `/api/v1/library-jobs/${id}/resume`,
    });
    assert.equal(resumed.statusCode, 200, resumed.body);
    await settled(() => repository.get(id)?.state === 'completed');
    assert.equal(repository.get(id)?.processed, 2);
    assert.equal(repository.get(id)?.failed, 0);
    assert.equal(matched.length, 3);
    assert.equal(
      matched.filter((sourceId) => sourceId === matched[0]).length,
      1,
      'Completed source must not run again',
    );
  } finally {
    full = false;
    repository.finishItem = finish;
    repository.state = state;
    await f.worker.close();
    await f.dispose();
  }
});

test('a failed scan claim wakes its waiting HTTP caller and a later request can recover the queue', async () => {
  const f = await fixture();
  const repository = f.catalog.libraryJobs;
  const next = repository.next.bind(repository);
  let full = false;
  try {
    registerLibraryJobs(f.worker, { catalog: f.catalog } as ServerContext, {
      async autoMatch() {
        return { status: 'unmatched', saved: 0, suggestions: 0, error: null };
      },
    });
    await f.worker.ready();
    await pause(10);
    repository.next = () => {
      if (full) throw diskFull();
      return next();
    };
    full = true;
    await assert.rejects(
      enqueueRootScan(f.catalog, { id: f.root.id, path: f.base }, f.owner.id),
      (error: unknown) => error instanceof DomainError && error.code === 'scan-interrupted',
    );
    full = false;
    const created = await f.worker.inject({
      method: 'POST',
      url: '/api/v1/library-jobs',
      payload: { kind: 'match', rootId: f.root.id },
    });
    assert.equal(created.statusCode, 202, created.body);
    await settled(() => repository.get(created.json().job.id)?.state === 'completed');
    assert.equal(repository.get(created.json().job.id)?.processed, 2);
  } finally {
    full = false;
    repository.next = next;
    await f.worker.close();
    await f.dispose();
  }
});

test('a disk-full queue claim is contained and can retry after space is restored', async () => {
  const f = await fixture();
  const repository = f.catalog.libraryJobs;
  const next = repository.next.bind(repository);
  let full = true;
  let claims = 0;
  try {
    repository.next = () => {
      claims++;
      if (full) throw diskFull();
      return next();
    };
    registerLibraryJobs(f.worker, { catalog: f.catalog } as ServerContext, {
      async autoMatch() {
        return { status: 'unmatched', saved: 0, suggestions: 0, error: null };
      },
    });
    await f.worker.ready();
    await settled(() => claims > 0);
    assert.equal(claims, 1, 'Failed claims must not spin');
    const job = repository.create(
      'match',
      { rootId: f.root.id },
      { online: false, checksum: false },
      f.owner.id,
    ).job;
    const read = await f.worker.inject({ url: `/api/v1/library-jobs/${job.id}` });
    assert.equal(read.json().job.state, 'interrupted');
    full = false;
    const resumed = await f.worker.inject({
      method: 'POST',
      url: `/api/v1/library-jobs/${job.id}/resume`,
    });
    assert.equal(resumed.statusCode, 200, resumed.body);
    await settled(() => repository.get(job.id)?.state === 'completed');
    assert.equal(repository.get(job.id)?.processed, 2);
  } finally {
    full = false;
    repository.next = next;
    await f.worker.close();
    await f.dispose();
  }
});
