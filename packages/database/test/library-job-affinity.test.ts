import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CatalogDatabase, MIGRATIONS } from '../src/index.js';
import { libraryJobPendingItemsQuery } from '../src/library-jobs.js';
import { companionDirectory, companionExtension, companionStem } from '../src/source-companions.js';

function priorCatalog(filename: string): DatabaseSync {
  const raw = new DatabaseSync(filename);
  raw.function('ecs_companion_parent', { deterministic: true }, (value) =>
    companionDirectory(String(value ?? '')),
  );
  raw.function('ecs_companion_stem', { deterministic: true }, (value) =>
    companionStem(String(value ?? '')),
  );
  raw.function('ecs_companion_extension', { deterministic: true }, (value) =>
    companionExtension(String(value ?? '')),
  );
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 19)) {
    raw.exec(migration.sql);
    raw.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(migration.version, 'generated');
  }
  raw.exec(`INSERT INTO users VALUES ('owner','owner','generated',1,'generated');
    INSERT INTO libraries VALUES ('library','Library','owner',1,'generated',NULL);
    INSERT INTO content_roots(id,path,label,library_id,created_at)
      VALUES ('root','/generated-never-read','Generated','library','generated');`);
  return raw;
}

function insertSource(raw: DatabaseSync, id: string, system: string | null): void {
  raw
    .prepare(`INSERT INTO source_files(id,root_id,relative_path,display_name,size,blocks,kind,system_id,availability,scanned_at)
    VALUES(?,'root',?,?,1,1,'rom',?,'local','generated')`)
    .run(id, `${id}.rom`, id, system);
}

test('v20 backfills match affinity and preserves scan/results on two opens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-affinity-migration-'));
  const filename = join(directory, 'catalog.sqlite');
  try {
    const prior = priorCatalog(filename);
    insertSource(prior, 'known', 'com.provenance.nes');
    insertSource(prior, 'unknown', null);
    // Deliberately collide a scan root entity with a source id: scans must stay untyped.
    insertSource(prior, 'root', 'com.provenance.snes');
    prior.exec(`INSERT INTO library_jobs(id,kind,scope_json,options_json,state,actor_id,created_at,updated_at,total,processed,saved,review)
      VALUES('match','match','{}','{"online":false,"checksum":true}','interrupted','owner','generated','generated',3,1,2,1);
      INSERT INTO library_jobs(id,kind,scope_json,options_json,state,actor_id,created_at,updated_at,total)
      VALUES('scan','scan','{}','{"online":false,"checksum":false}','queued','owner','generated','generated',1);
      INSERT INTO library_job_items(job_id,entity_id,state,saved,suggestions,error)
      VALUES('match','known','review',2,3,'preserved'),('match','unknown','pending',0,0,NULL),('match','removed','pending',0,0,NULL);
      INSERT INTO library_job_items(job_id,entity_id,result_json) VALUES('scan','root','{"count":7}');`);
    prior.close();
    for (let count = 0; count < 2; count++) {
      const catalog = new CatalogDatabase(filename);
      const raw = new DatabaseSync(filename, { readOnly: true });
      try {
        const rows = raw
          .prepare(
            'SELECT entity_id,system_id,state,saved,suggestions,error FROM library_job_items WHERE job_id=? ORDER BY entity_id',
          )
          .all('match');
        assert.deepEqual(
          rows.map((row) => ({ ...row })),
          [
            {
              entity_id: 'known',
              system_id: 'com.provenance.nes',
              state: 'review',
              saved: 2,
              suggestions: 3,
              error: 'preserved',
            },
            {
              entity_id: 'removed',
              system_id: null,
              state: 'pending',
              saved: 0,
              suggestions: 0,
              error: null,
            },
            {
              entity_id: 'unknown',
              system_id: null,
              state: 'pending',
              saved: 0,
              suggestions: 0,
              error: null,
            },
          ],
        );
        assert.equal(
          raw.prepare('SELECT system_id FROM library_job_items WHERE job_id=?').get('scan')
            ?.system_id,
          null,
        );
        assert.deepEqual(catalog.libraryJobs.scanResult('scan', 'root'), { count: 7 });
        const job = catalog.libraryJobs.get('match');
        assert.equal(job?.processed, 1);
        assert.equal(job?.saved, 2);
        assert.equal(job?.review, 1);
        assert.equal(catalog.integrity(), 'ok');
      } finally {
        raw.close();
        catalog.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pending work groups 65 interleaved systems using an index while public cursors keep source order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-affinity-order-'));
  const filename = join(directory, 'catalog.sqlite');
  const prior = priorCatalog(filename);
  for (let index = 0; index < 195; index++)
    insertSource(
      prior,
      String(index).padStart(6, '0'),
      `org.generated.system${String(index % 65).padStart(2, '0')}`,
    );
  prior.close();
  const catalog = new CatalogDatabase(filename);
  const raw = new DatabaseSync(filename);
  try {
    const job = catalog.libraryJobs.create(
      'match',
      {},
      { online: false, checksum: true },
      'owner',
    ).job;
    const repository = catalog.libraryJobs;
    assert.equal(catalog.libraryJobs.next()?.job.id, job.id);
    const first = catalog.libraryJobs.items(job.id, 2);
    assert.deepEqual(
      first.map((item) => item.sourceId),
      ['000000', '000001'],
    );
    assert.deepEqual(
      catalog.libraryJobs.items(job.id, 2, '000001').map((item) => item.sourceId),
      ['000002', '000003'],
    );
    // A large processed prefix must not be scanned again for every pending batch.
    raw
      .prepare(
        "WITH RECURSIVE seq(value) AS (SELECT 0 UNION ALL SELECT value+1 FROM seq WHERE value<59999) INSERT INTO library_job_items(job_id,entity_id,state,system_id) SELECT ?,printf('done-%06d',value),'saved','org.generated.system00' FROM seq",
      )
      .run(job.id);
    const query = libraryJobPendingItemsQuery(job.id, 50);
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as {
      detail: string;
    }[];
    assert.ok(
      plan.some(
        (row) =>
          row.detail.includes('library_job_items_affinity') &&
          row.detail.includes('job_id=? AND state=?'),
      ),
      JSON.stringify(plan),
    );
    assert.ok(!plan.some((row) => row.detail.includes('TEMP B-TREE')), JSON.stringify(plan));
    const processed: string[] = [];
    for (;;) {
      const batch = repository.pendingItems(job.id, 50);
      if (!batch.length) break;
      assert.ok(batch.length <= 50);
      for (const item of batch) {
        const system = raw
          .prepare('SELECT system_id FROM library_job_items WHERE job_id=? AND entity_id=?')
          .get(job.id, item.sourceId)?.system_id;
        assert.equal(typeof system, 'string');
        processed.push(String(system));
        repository.finishItem(job.id, { ...item, status: 'unmatched' });
      }
    }
    assert.equal(processed.length, 195);
    assert.deepEqual(processed, [...processed].sort());
    assert.equal(new Set(processed).size, 65);
    for (const system of new Set(processed))
      assert.equal(processed.filter((value) => value === system).length, 3);

    repository.state(job.id, 'completed');
    raw
      .prepare('UPDATE source_files SET system_id=? WHERE id=?')
      .run('org.generated.changed', '000001');
    insertSource(raw, 'new-after-scan', 'org.generated.new');
    repository.resume(job.id, 'unmatched');
    assert.equal(repository.next()?.job.id, job.id);
    assert.equal(
      raw
        .prepare('SELECT system_id FROM library_job_items WHERE job_id=? AND entity_id=?')
        .get(job.id, '000001')?.system_id,
      'org.generated.changed',
    );
    assert.equal(
      raw
        .prepare('SELECT system_id FROM library_job_items WHERE job_id=? AND entity_id=?')
        .get(job.id, 'new-after-scan')?.system_id,
      'org.generated.new',
    );
    const scan = repository.create('scan', {}, { online: false, checksum: false }, 'owner').job;
    assert.equal(
      raw.prepare('SELECT system_id FROM library_job_items WHERE job_id=?').get(scan.id)?.system_id,
      null,
    );
  } finally {
    raw.close();
    catalog.close();
    await rm(directory, { recursive: true, force: true });
  }
});
