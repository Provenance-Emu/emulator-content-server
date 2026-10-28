import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CatalogDatabase } from '../src/index.js';

test('durable job snapshots recover interrupted work without repeating completed source outcomes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-jobs-'));
  const path = join(directory, 'catalog.sqlite');
  let catalog = new CatalogDatabase(path);
  try {
    const owner = catalog.createUser({
      username: 'generated',
      passwordHash: 'generated',
      actorId: 'test',
    });
    const library = catalog.createLibrary(owner.id, 'Generated');
    const root = catalog.createContentRoot({
      path: directory,
      label: 'Generated',
      libraryId: library.id,
      actorId: owner.id,
    });
    catalog.applyInspection({
      rootId: root.id,
      actorId: owner.id,
      online: true,
      files: Array.from({ length: 250 }, (_, index) => ({
        relativePath: `Generated-${index}.nes`,
        displayName: `Generated-${index}.nes`,
        kind: 'rom',
        size: 4,
        blocks: 1,
        systemId: null,
        availability: 'local' as const,
      })),
    });
    const result = catalog.libraryJobs.create(
      'match',
      { libraryId: library.id },
      { online: false, checksum: true },
      owner.id,
    );
    assert.equal(result.job.total, 250);
    assert.equal(
      catalog.libraryJobs.items(result.job.id, 101).length,
      101,
      'internal lookahead preserves pagination at the public maximum of 100',
    );
    assert.equal(catalog.libraryJobs.next()?.job.id, result.job.id);
    const page = catalog.libraryJobs.items(result.job.id, 2, undefined, 'pending');
    const completed = page[0];
    assert.ok(completed);
    catalog.libraryJobs.finishItem(result.job.id, {
      ...completed,
      status: 'review',
      saved: 1,
      suggestions: 2,
    });
    catalog.libraryJobs.finishItem(result.job.id, {
      ...completed,
      status: 'review',
      saved: 1,
      suggestions: 2,
    });
    assert.equal(catalog.libraryJobs.get(result.job.id)?.processed, 1);
    assert.equal(catalog.libraryJobs.get(result.job.id)?.saved, 1);
    catalog.close();
    catalog = new CatalogDatabase(path);
    catalog.libraryJobs.recover();
    const interrupted = catalog.libraryJobs.get(result.job.id);
    assert.equal(interrupted?.state, 'interrupted');
    assert.equal(interrupted?.interruptedCount, 1);
    assert.equal(interrupted?.processed, 1);
    assert.equal(catalog.libraryJobs.next(), null);
    catalog.libraryJobs.resume(result.job.id);
    assert.equal(catalog.libraryJobs.next()?.job.id, result.job.id);
    const pending = catalog.libraryJobs.items(result.job.id, 100, undefined, 'pending');
    assert.equal(pending.length, 100);
    assert.ok(!pending.some((item) => item.sourceId === completed.sourceId));
    const reused = catalog.libraryJobs.create(
      'match',
      { rootId: root.id },
      { online: false, checksum: true },
      owner.id,
    );
    assert.equal(reused.reused, true);
    assert.equal(reused.job.id, result.job.id);
    assert.throws(
      () =>
        catalog.libraryJobs.create(
          'match',
          { rootId: root.id },
          { online: true, checksum: true },
          owner.id,
        ),
      /already covers/,
    );
    catalog.libraryJobs.state(result.job.id, 'cancelled');
    const another = catalog.libraryJobs.create(
      'match',
      { rootId: root.id },
      { online: false, checksum: true },
      owner.id,
    );
    assert.throws(() => catalog.libraryJobs.resume(result.job.id), /Another shared job/);
    assert.notEqual(another.job.id, result.job.id);
  } finally {
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('pending work seeks the state index beyond 60,000 processed sources', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { libraryJobItemsQuery } = await import('../src/library-jobs.js');
  const directory = await mkdtemp(join(tmpdir(), 'ecs-job-plan-'));
  const filename = join(directory, 'catalog.sqlite');
  const catalog = new CatalogDatabase(filename);
  try {
    const owner = catalog.createUser({
      username: 'generated',
      passwordHash: 'generated',
      actorId: 'test',
    });
    const job = catalog.libraryJobs.create(
      'match',
      {},
      { online: false, checksum: true },
      owner.id,
    ).job;
    const raw = new DatabaseSync(filename);
    try {
      raw
        .prepare(
          "WITH RECURSIVE seq(value) AS (SELECT 0 UNION ALL SELECT value+1 FROM seq WHERE value<59999) INSERT INTO library_job_items(job_id,entity_id,state) SELECT ?,printf('%06d',value),'saved' FROM seq",
        )
        .run(job.id);
      raw
        .prepare("INSERT INTO library_job_items(job_id,entity_id) VALUES(?,'zz-pending')")
        .run(job.id);
      const query = libraryJobItemsQuery(job.id, 50, undefined, 'pending');
      const plan = raw.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as {
        detail: string;
      }[];
      assert.ok(
        plan.some(
          (row) =>
            row.detail.includes('library_job_items_queue') &&
            row.detail.includes('job_id=? AND state=?'),
        ),
        JSON.stringify(plan),
      );
      assert.ok(!plan.some((row) => row.detail.includes('TEMP B-TREE')), JSON.stringify(plan));
      assert.deepEqual(
        catalog.libraryJobs.items(job.id, 50, undefined, 'pending').map((item) => item.sourceId),
        ['zz-pending'],
      );
    } finally {
      raw.close();
    }
  } finally {
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('equivalent legacy option order and disabled filename fallback reuse the existing job', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-job-policy-'));
  const path = join(directory, 'catalog.sqlite');
  const catalog = new CatalogDatabase(path);
  try {
    const owner = catalog.createUser({
      username: 'generated',
      passwordHash: 'generated',
      actorId: 'fixture',
    });
    const library = catalog.createLibrary(owner.id, 'Generated');
    const root = catalog.createContentRoot({
      path: directory,
      label: 'Generated',
      libraryId: library.id,
      actorId: owner.id,
    });
    const options = {
      online: false,
      checksum: true,
      providerIds: ['test.b', 'test.a'],
      managerId: 'org.ecs.matches',
    };
    const first = catalog.libraryJobs.create('match', { rootId: root.id }, options, owner.id);
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE library_jobs SET options_json=? WHERE id=?').run(
      JSON.stringify({
        providerIds: ['test.a', 'test.b'],
        checksum: true,
        online: false,
        managerId: 'org.ecs.matches',
      }),
      first.job.id,
    );
    raw.close();
    const repeated = catalog.libraryJobs.create(
      'match',
      { rootId: root.id },
      { ...options, allowExactNames: false },
      owner.id,
    );
    assert.equal(repeated.reused, true);
    assert.equal(repeated.job.id, first.job.id);
    assert.throws(
      () =>
        catalog.libraryJobs.create(
          'match',
          { rootId: root.id },
          { ...options, allowExactNames: true },
          owner.id,
        ),
      /shared job already covers/i,
    );
  } finally {
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  }
});
