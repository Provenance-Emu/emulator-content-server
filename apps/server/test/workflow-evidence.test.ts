import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { libraryFixture } from './library-fixture.js';

test('cleanup inspection stamps scoped evidence without changing selections or exposing paths', async () => {
  const f = await libraryFixture();
  try {
    const path = join(f.base, 'games');
    await mkdir(path);
    await writeFile(join(path, 'Game.j64'), Buffer.from([1, 2, 3, 4]));
    await writeFile(
      join(path, 'Game.json'),
      JSON.stringify({ title: 'Generated Game', publisher: 'Homebrew' }),
    );
    const root = f.catalog.createContentRoot({
      path,
      label: 'Games',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(root.id).find((s) => s.displayName === 'Game.j64');
    assert.ok(source);
    const enrollment = issueToken(),
      worker = issueToken();
    const host = f.catalog.workflowIdentities.createHost(
      f.owner.id,
      'Evidence host',
      enrollment.hash,
      Date.now() + 600_000,
    );
    f.catalog.workflowIdentities.enrollHost(enrollment.hash, worker.hash);
    const run = f.catalog.workflowRuns.createRun(
      {
        workflowId: 'org.ecs.library-cleanup',
        workflowDigest: 'c'.repeat(64),
        hostId: host.id,
        scope: { libraryId: f.library.id },
        options: { online: false, checksum: true, shareImages: false },
      },
      f.owner.id,
    );
    const lease = f.catalog.workflowRuns.claimRun(host.id);
    assert.ok(lease);
    const headers = { authorization: `Bearer ${worker.token}` };
    const url = `/api/v1/workflow-workers/runs/${run.id}/sources/${source.id}`;
    const before = f.catalog.sourceMatches(source.id);
    const facts = await f.app.inject({ url: `${url}/facts`, headers });
    assert.equal(facts.statusCode, 200, facts.body);
    assert.ok(facts.json().evidenceIds.length);
    const result = await f.app.inject({
      method: 'POST',
      url: `${url}/catalog`,
      headers,
      payload: {},
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(
      result.json().candidates.some((c: { title: string }) => c.title === 'Generated Game'),
    );
    assert.equal(result.body.includes(path), false);
    assert.equal(result.body.includes('relativePath'), false);
    const repeated = await f.app.inject({
      method: 'POST',
      url: `${url}/catalog`,
      headers,
      payload: {},
    });
    assert.deepEqual(repeated.json(), result.json());
    const observation = {
      sourceId: source.id,
      kind: 'missing-front-artwork',
      reason: 'No front cover is saved.',
      evidenceIds: result.json().facts.evidenceIds,
      candidateIds: [],
    };
    const suggestions = await f.app.inject({
      method: 'POST',
      url: `/api/v1/workflow-workers/runs/${run.id}/suggestions`,
      headers,
      payload: { sourceId: source.id, observations: [observation] },
    });
    assert.equal(suggestions.statusCode, 200, suggestions.body);
    const listed = await f.app.inject({
      url: `/api/v1/workflow-runs/${run.id}/findings`,
      headers: f.auth,
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().items[0].kind, 'missing-front-artwork');
    const forgedSuggestion = await f.app.inject({
      method: 'POST',
      url: `/api/v1/workflow-workers/runs/${run.id}/suggestions`,
      headers,
      payload: {
        sourceId: source.id,
        observations: [
          { ...observation, evidenceIds: ['invented-evidence'], confidence: 'checksum' },
        ],
      },
    });
    assert.equal(forgedSuggestion.statusCode, 400);
    assert.deepEqual(f.catalog.sourceMatches(source.id), before);
    assert.equal(f.catalog.getSource(source.id)?.relativePath, 'Game.j64');
    const forged = await f.app.inject({
      method: 'POST',
      url: `${url}/catalog`,
      headers,
      payload: { md5: 'f'.repeat(32), online: true },
    });
    assert.equal(forged.statusCode, 400);
    const foreign = await f.app.inject({
      url: `/api/v1/workflow-workers/runs/${run.id}/sources/not-in-scope/facts`,
      headers,
    });
    assert.equal(foreign.statusCode, 404);
    const record = {
      id: 'saved-correct',
      providerId: 'org.example.catalog',
      kind: 'metadata',
      title: 'Generated Game',
      confidence: 'checksum',
      metadata: {
        systemId: source.systemId ?? 'com.provenance.jaguar',
        md5: createHash('md5')
          .update(Buffer.from([1, 2, 3, 4]))
          .digest('hex'),
        hashSize: '4',
        hashRepresentation: 'raw',
        hashVerified: 'true',
        matchEvidence: 'verified-hash',
      },
      originKind: null,
      contentAvailable: false,
      contentType: null,
      fileName: null,
      updatedAt: '2030-01-01T00:00:00Z',
    } as const;
    f.catalog.saveSourceMatch(source.id, 0, 'metadata', record, null, f.owner.id);
    const correct = await f.app.inject({
      method: 'POST',
      url: `${url}/catalog`,
      headers,
      payload: {},
    });
    assert.equal(correct.statusCode, 200, correct.body);
    assert.equal(
      correct.json().facts.selected.find((s: { kind: string }) => s.kind === 'metadata')
        .identityConflict,
      false,
    );
    f.catalog.saveSourceMatch(
      source.id,
      1,
      'metadata',
      { ...record, id: 'saved-wrong', metadata: { ...record.metadata, md5: 'f'.repeat(32) } },
      null,
      f.owner.id,
    );
    const wrong = await f.app.inject({
      method: 'POST',
      url: `${url}/catalog`,
      headers,
      payload: {},
    });
    assert.equal(wrong.statusCode, 200, wrong.body);
    assert.equal(
      wrong.json().facts.selected.find((s: { kind: string }) => s.kind === 'metadata')
        .identityConflict,
      true,
    );
    f.catalog.workflowRuns.cancelRun(run.id, f.owner.id);
    assert.equal(
      (await f.app.inject({ method: 'POST', url: `${url}/catalog`, headers, payload: {} }))
        .statusCode,
      409,
    );
  } finally {
    await f.dispose();
  }
});
