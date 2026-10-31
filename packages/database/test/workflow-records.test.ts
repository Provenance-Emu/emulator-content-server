import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CatalogDatabase } from '../src/catalog.js';
import { MIGRATIONS } from '../src/schema.js';
import { companionDirectory, companionExtension, companionStem } from '../src/source-companions.js';

async function fixture(count = 55) {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-workflow-records-'));
  const path = join(directory, 'catalog.sqlite');
  const catalog = new CatalogDatabase(path);
  catalog.saveBootstrapHash('0'.repeat(64));
  const bootstrapped = catalog.bootstrap({
    bootstrapTokenHash: '0'.repeat(64),
    username: 'owner',
    passwordHash: 'generated-password-hash',
    sessionHash: 'f'.repeat(64),
    libraryName: 'Initial generated library',
  });
  const owner = { id: bootstrapped.userId };
  const library = catalog.createLibrary(owner.id, 'Generated library');
  const root = catalog.createContentRoot({
    path: join(directory, 'files'),
    label: 'Generated',
    libraryId: library.id,
    actorId: owner.id,
  });
  catalog.applyInspection({
    rootId: root.id,
    actorId: owner.id,
    online: true,
    files: Array.from({ length: count }, (_, index) => ({
      relativePath: `Game-${index}.nes`,
      displayName: `Game-${index}.nes`,
      kind: 'rom',
      size: 4,
      blocks: 1,
      systemId: 'com.provenance.nes',
      availability: 'local' as const,
    })),
  });
  const host = catalog.workflowIdentities.createHost(
    owner.id,
    'Generated host',
    'a'.repeat(64),
    600_000,
  );
  const draft = {
    workflowId: 'org.ecs.library-cleanup',
    workflowDigest: 'b'.repeat(64),
    hostId: host.id,
    scope: { libraryId: library.id },
    options: { online: false, checksum: false, shareImages: false },
  };
  return {
    directory,
    path,
    catalog,
    owner,
    library,
    root,
    host,
    draft,
    close: async () => {
      catalog.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('workflow work lists are frozen, keyset paged and never change selections', async () => {
  const f = await fixture();
  try {
    const run = f.catalog.workflowRuns.createRun(f.draft, f.owner.id, 0);
    assert.equal(run.total, 55);
    assert.equal(f.catalog.workflowRuns.createRun(f.draft, f.owner.id, 1).id, run.id);
    assert.throws(() =>
      f.catalog.workflowRuns.createRun(
        { ...f.draft, options: { ...f.draft.options, online: true } },
        f.owner.id,
        2,
      ),
    );
    const first = f.catalog.workflowRuns.pageWork(run.id, undefined, 50);
    assert.equal(first.items.length, 50);
    assert.ok(first.nextCursor);
    const second = f.catalog.workflowRuns.pageWork(run.id, first.nextCursor, 50);
    assert.equal(second.items.length, 5);
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.sourceId)).size, 55);
    const source = first.items[0];
    assert.ok(source);
    assert.equal(source.selectionRevision, 0);
    assert.deepEqual(f.catalog.sourceMatches(source.sourceId).matches, []);
    assert.throws(() =>
      f.catalog.workflowRuns.createRun(
        { ...f.draft, scope: { libraryId: 'other-library' } },
        f.owner.id,
        0,
      ),
    );
  } finally {
    await f.close();
  }
});

test('leases fence old publication and publication replay is content-bound', async () => {
  const f = await fixture(1);
  try {
    f.catalog.workflowIdentities.enrollHost('a'.repeat(64), 'c'.repeat(64), 0);
    const run = f.catalog.workflowRuns.createRun(f.draft, f.owner.id, 0);
    const lease = f.catalog.workflowRuns.claimRun(f.host.id, 0);
    assert.ok(lease);
    const item = f.catalog.workflowRuns.pageWork(run.id).items[0];
    assert.ok(item);
    assert.throws(() =>
      f.catalog.workflowRuns.publish(
        lease,
        {
          sequence: 1,
          checkpointRef: 'invalid',
          completedSourceIds: [item.sourceId, 'outside-run'],
        },
        900,
      ),
    );
    assert.equal(f.catalog.workflowRuns.pageWork(run.id).items[0]?.state, 'pending');
    const publication = {
      sequence: 1,
      checkpointRef: 'checkpoint-1',
      completedSourceIds: [item.sourceId],
      state: 'completed' as const,
      sourceOutputs: [{ sourceId: item.sourceId, outputJson: '{"unresolved":"provider-failed"}' }],
    };
    const published = f.catalog.workflowRuns.publish(lease, publication, 1000);
    assert.equal(published.processed, 1);
    assert.equal(published.state, 'completed');
    assert.equal(
      f.catalog.workflowRuns.pageWork(run.id).items[0]?.outputJson,
      '{"unresolved":"provider-failed"}',
    );
    assert.deepEqual(f.catalog.workflowRuns.publish(lease, publication, 1001), published);
    assert.throws(() =>
      f.catalog.workflowRuns.publish(lease, { ...publication, checkpointRef: 'changed' }, 1001),
    );
    const next = f.catalog.workflowRuns.createRun(f.draft, f.owner.id, 2000);
    const expired = f.catalog.workflowRuns.claimRun(f.host.id, 2000);
    assert.ok(expired);
    f.catalog.workflowRuns.recoverRuns(62_001);
    f.catalog.workflowRuns.resumeRun(next.id, f.owner.id, 62_001);
    const renewed = f.catalog.workflowRuns.claimRun(f.host.id, 62_001);
    assert.ok(renewed);
    assert.ok(renewed.fence > expired.fence);
    assert.throws(() =>
      f.catalog.workflowRuns.publish(
        expired,
        { sequence: 1, checkpointRef: 'stale', completedSourceIds: [] },
        62_002,
      ),
    );
  } finally {
    await f.close();
  }
});

test('dismissals survive reruns until relevant evidence or the saved choice changes', async () => {
  const f = await fixture(1);
  try {
    const run = f.catalog.workflowRuns.createRun(f.draft, f.owner.id, 0);
    const source = f.catalog.workflowRuns.pageWork(run.id).items[0];
    assert.ok(source);
    const finding = f.catalog.workflowProposals.addFinding(run.id, {
      sourceId: source.sourceId,
      kind: 'missing-front-artwork',
      ruleVersion: 'missing-front@1',
      currentValueDigest: 'd'.repeat(64),
      evidenceDigest: 'e'.repeat(64),
      reason: 'No front artwork',
      evidenceIds: [],
    });
    f.catalog.workflowProposals.recordDecision(finding.id, 'keep', f.owner.id);
    assert.equal(f.catalog.workflowProposals.isDismissed(finding), true);
    assert.equal(
      f.catalog.workflowProposals.isDismissed({ ...finding, evidenceDigest: 'f'.repeat(64) }),
      false,
    );
    assert.equal(
      f.catalog.workflowProposals.isDismissed({ ...finding, currentValueDigest: '0'.repeat(64) }),
      false,
    );
    assert.equal(f.catalog.workflowProposals.pageFindings(run.id).items.length, 1);
    assert.throws(() =>
      f.catalog.workflowProposals.addFinding(run.id, { ...finding, sourceId: 'not-in-run' }),
    );
  } finally {
    await f.close();
  }
});

test('the workflow migration preserves a v20 catalog through two opens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-workflow-v20-'));
  const path = join(directory, 'catalog.sqlite');
  const old = new DatabaseSync(path);
  try {
    old.function('ecs_companion_parent', (value) => companionDirectory(String(value)));
    old.function('ecs_companion_stem', (value) => companionStem(String(value)));
    old.function('ecs_companion_extension', (value) => companionExtension(String(value)));
    for (const migration of MIGRATIONS.filter((migration) => migration.version <= 20)) {
      old.exec(migration.sql);
      old
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(migration.version, '2026-10-29T00:00:00.000Z');
    }
    old
      .prepare('INSERT INTO users(id,username,password_hash,is_owner,created_at) VALUES(?,?,?,?,?)')
      .run('owner', 'owner', 'generated-hash', 1, '2026-10-29');
    old
      .prepare('INSERT INTO libraries(id,name,owner_id,revision,created_at) VALUES(?,?,?,?,?)')
      .run('library', 'Existing generated library', 'owner', 7, '2026-10-29');
    old
      .prepare('INSERT INTO content_roots(id,path,label,library_id,created_at) VALUES(?,?,?,?,?)')
      .run('root', '/generated-workflow-fixture', 'Generated', 'library', '2026-10-29');
    old
      .prepare(
        'INSERT INTO source_files(id,root_id,relative_path,display_name,size,blocks,kind,system_id,availability,scanned_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'source',
        'root',
        'Generated.nes',
        'Generated.nes',
        4,
        1,
        'rom',
        'com.provenance.nes',
        'local',
        '2026-10-29',
      );
    old.prepare('INSERT INTO source_match_state(source_id,revision) VALUES(?,?)').run('source', 5);
    old
      .prepare(
        'INSERT INTO source_match_selections(source_id,kind,artwork_role,selection_json,content) VALUES(?,?,?,?,?)',
      )
      .run(
        'source',
        'artwork',
        'front',
        JSON.stringify({
          id: 'existing-art',
          kind: 'artwork',
          title: 'Generated saved cover',
          artworkRole: 'front',
        }),
        Buffer.from([1, 2, 3, 4]),
      );
    old
      .prepare(
        'INSERT INTO library_jobs(id,kind,scope_json,options_json,state,actor_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        'legacy-job',
        'match',
        JSON.stringify({ libraryId: 'library' }),
        JSON.stringify({ online: false, checksum: false }),
        'completed',
        'owner',
        '2026-10-29',
        '2026-10-29',
      );
  } finally {
    old.close();
  }
  try {
    for (let index = 0; index < 2; index++) {
      const reopened = new CatalogDatabase(path);
      try {
        assert.equal(reopened.getLibrary('library')?.revision, 7);
        assert.equal(reopened.sourceMatches('source').revision, 5);
        assert.equal(reopened.sourceMatches('source').matches[0]?.title, 'Generated saved cover');
        assert.deepEqual(
          Array.from(reopened.sourceMatchContent('source', 'artwork') ?? []),
          [1, 2, 3, 4],
        );
        assert.equal(reopened.libraryJobs.get('legacy-job')?.state, 'completed');
        assert.equal(reopened.integrity(), 'ok');
        assert.deepEqual(reopened.workflowRuns.listRuns().items, []);
      } finally {
        reopened.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('pending work seeks past ten thousand completed rows using its queue index', async () => {
  const f = await fixture(10_001);
  try {
    const run = f.catalog.workflowRuns.createRun(f.draft, f.owner.id, 0);
    const raw = new DatabaseSync(f.path);
    try {
      raw
        .prepare(
          "UPDATE workflow_work SET state='completed' WHERE run_id=? AND source_id<>(SELECT max(source_id) FROM workflow_work WHERE run_id=?)",
        )
        .run(run.id, run.id);
      const query = raw
        .prepare(
          "EXPLAIN QUERY PLAN SELECT source_id FROM workflow_work WHERE run_id=? AND state='pending' AND source_id>? ORDER BY source_id LIMIT 50",
        )
        .all(run.id, '');
      assert.ok(JSON.stringify(query).includes('workflow_work_page'));
    } finally {
      raw.close();
    }
    const remaining = f.catalog.workflowRuns.pagePendingWork(run.id);
    assert.equal(remaining.items.length, 1);
    assert.equal(remaining.items[0]?.state, 'pending');
  } finally {
    await f.close();
  }
});

test('explicit source scopes cannot combine different libraries', async () => {
  const f = await fixture(1);
  try {
    const first = f.catalog.workflowRuns.createRun(f.draft, f.owner.id, 0);
    const id = f.catalog.workflowRuns.pageWork(first.id).items[0]?.sourceId;
    assert.ok(id);
    const other = f.catalog.createLibrary(f.owner.id, 'Other generated library');
    const root = f.catalog.createContentRoot({
      path: join(f.directory, 'other'),
      label: 'Other',
      libraryId: other.id,
      actorId: f.owner.id,
    });
    f.catalog.applyInspection({
      rootId: root.id,
      actorId: f.owner.id,
      online: true,
      files: [
        {
          relativePath: 'Other.nes',
          displayName: 'Other.nes',
          kind: 'rom',
          size: 4,
          blocks: 1,
          systemId: 'com.provenance.nes',
          availability: 'local',
        },
      ],
    });
    const second = f.catalog.workflowRuns.createRun(
      { ...f.draft, scope: { libraryId: other.id } },
      f.owner.id,
      0,
    );
    const otherId = f.catalog.workflowRuns.pageWork(second.id).items[0]?.sourceId;
    assert.ok(otherId);
    assert.throws(() =>
      f.catalog.workflowRuns.createRun(
        { ...f.draft, scope: { sourceIds: [id, otherId] } },
        f.owner.id,
        0,
      ),
    );
  } finally {
    await f.close();
  }
});

test('run creation request keys survive terminal state and response-cache loss', async () => {
  const f = await fixture(1);
  try {
    const run = f.catalog.workflowRuns.createRun(f.draft, f.owner.id, 0, 'generated-request-key');
    f.catalog.workflowRuns.cancelRun(run.id, f.owner.id, 1);
    assert.equal(
      f.catalog.workflowRuns.createRun(f.draft, f.owner.id, 2, 'generated-request-key').id,
      run.id,
    );
    assert.throws(() =>
      f.catalog.workflowRuns.createRun(
        { ...f.draft, options: { ...f.draft.options, online: true } },
        f.owner.id,
        3,
        'generated-request-key',
      ),
    );
  } finally {
    await f.close();
  }
});

test('host recovery reports fence further work and require explicit owner recovery', async () => {
  const f = await fixture(1);
  try {
    f.catalog.workflowIdentities.enrollHost('a'.repeat(64), 'c'.repeat(64), 0);
    const run = f.catalog.workflowRuns.createRun(f.draft, f.owner.id, 0);
    const lease = f.catalog.workflowRuns.claimRun(f.host.id, 0);
    assert.ok(lease);
    const failed = f.catalog.workflowRuns.interrupt(lease, true, 1);
    assert.equal(failed.state, 'recovery-required');
    assert.throws(() => f.catalog.workflowRuns.heartbeat(lease, 2));
    assert.throws(() => f.catalog.workflowRuns.resumeRun(run.id, f.owner.id, 2));
  } finally {
    await f.close();
  }
});

test('a renewed lease reconciles an identical committed publication while the old lease stays fenced', async () => {
  const f = await fixture(2);
  try {
    f.catalog.workflowIdentities.enrollHost('a'.repeat(64), 'c'.repeat(64), 0);
    const run = f.catalog.workflowRuns.createRun(f.draft, f.owner.id, 0);
    const firstLease = f.catalog.workflowRuns.claimRun(f.host.id, 0);
    assert.ok(firstLease);
    const source = f.catalog.workflowRuns.pageWork(run.id).items[0];
    assert.ok(source);
    const publication = {
      sequence: 1,
      checkpointRef: 'committed-before-disconnect',
      completedSourceIds: [source.sourceId],
    };
    const committed = f.catalog.workflowRuns.publish(firstLease, publication, 1000);
    f.catalog.workflowRuns.recoverRuns(60_001);
    f.catalog.workflowRuns.resumeRun(run.id, f.owner.id, 60_002);
    const renewed = f.catalog.workflowRuns.claimRun(f.host.id, 60_003);
    assert.ok(renewed);
    assert.deepEqual(f.catalog.workflowRuns.publish(renewed, publication, 60_004), committed);
    assert.throws(() => f.catalog.workflowRuns.publish(firstLease, publication, 60_004));
    assert.throws(() =>
      f.catalog.workflowRuns.publish(
        renewed,
        { ...publication, checkpointRef: 'different' },
        60_004,
      ),
    );
    assert.equal(f.catalog.workflowRuns.getRun(run.id)?.processed, 1);
  } finally {
    await f.close();
  }
});
