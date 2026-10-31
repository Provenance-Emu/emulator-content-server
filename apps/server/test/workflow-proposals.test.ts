import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { ServerContext } from '../src/context.js';
import { openServer } from '../src/index.js';
import { describeRaster } from '../src/matching-files.js';
import type { SourceMatchingService } from '../src/source-matching.js';
import {
  materializeCleanupProposal,
  validateWorkflowArtworkDestination,
} from '../src/workflow-artifacts.js';
import { generatedPng, workflowFixture } from './workflow-fixture.js';

test('raster staging bounds dimensions, structure and bytes; artwork destinations cannot be private or redirected', () => {
  assert.deepEqual(describeRaster(generatedPng()), {
    contentType: 'image/png',
    width: 2,
    height: 2,
  });
  assert.throws(() => describeRaster(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const corrupt = generatedPng();
  corrupt[25] = 99;
  assert.throws(() => describeRaster(corrupt));
  assert.throws(() => describeRaster(Buffer.alloc(2 * 1024 * 1024 + 1)));
  assert.throws(() => describeRaster(generatedPng(16385, 1)));
  assert.throws(() =>
    validateWorkflowArtworkDestination('http://127.0.0.1/cover.png', ['127.0.0.1']),
  );
  assert.throws(() =>
    validateWorkflowArtworkDestination(
      'https://raw.githubusercontent.com/libretro-thumbnails/NES/a.png',
      ['10.0.0.2'],
    ),
  );
  assert.throws(() =>
    validateWorkflowArtworkDestination('https://raw.githubusercontent.com/another/path.png', [
      '185.199.108.133',
    ]),
  );
  assert.doesNotThrow(() =>
    validateWorkflowArtworkDestination(
      'https://raw.githubusercontent.com/libretro-thumbnails/NES/a.png',
      ['185.199.108.133'],
    ),
  );
});

test('cleanup identifies malformed selected front artwork without changing the saved bytes', async () => {
  const f = await workflowFixture();
  try {
    const broken = Buffer.from('generated-invalid-raster');
    f.catalog.saveSourceMatch(
      f.source.id,
      0,
      'artwork',
      {
        id: 'broken-cover',
        providerId: 'org.example.legacy',
        kind: 'artwork',
        title: 'Generated cover',
        confidence: 'local',
        metadata: { artworkRole: 'front' },
        originKind: null,
        contentAvailable: true,
        contentType: 'image/png',
        fileName: 'cover.png',
        updatedAt: '2030-01-01T00:00:00Z',
      },
      broken,
      f.owner.id,
    );
    const facts = await f.app.inject({
      url: `${f.baseUrl}/sources/${f.source.id}/facts`,
      headers: f.workerHeaders,
    });
    assert.equal(facts.statusCode, 200, facts.body);
    assert.equal(
      facts.json().selected.find((s: { kind: string }) => s.kind === 'artwork').contentAvailable,
      false,
    );
    assert.deepEqual(
      Buffer.from(f.catalog.sourceMatchContent(f.source.id, 'artwork') ?? []),
      broken,
    );
    assert.equal(f.catalog.sourceMatches(f.source.id).revision, 1);
  } finally {
    await f.dispose();
  }
});

test('evidence reference order does not duplicate a cleanup finding', async () => {
  const f = await workflowFixture();
  try {
    const art = f.inspection.candidates.find((c: { kind: string }) => c.kind === 'artwork');
    assert.ok(art);
    const evidenceIds = [...f.inspection.facts.evidenceIds, ...art.evidenceIds];
    const observation = {
      sourceId: f.source.id,
      kind: 'missing-front-artwork',
      reason: 'Missing cover',
      evidenceIds,
      candidateIds: [],
    };
    const first = await f.app.inject({
      method: 'POST',
      url: `${f.baseUrl}/suggestions`,
      headers: f.workerHeaders,
      payload: { sourceId: f.source.id, observations: [observation] },
    });
    const second = await f.app.inject({
      method: 'POST',
      url: `${f.baseUrl}/suggestions`,
      headers: f.workerHeaders,
      payload: {
        sourceId: f.source.id,
        observations: [{ ...observation, evidenceIds: [...evidenceIds].reverse() }],
      },
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().findings[0].id, first.json().findings[0].id);
  } finally {
    await f.dispose();
  }
});

test('review artwork and metadata are immutable snapshots independent of matching previews and source resources', async () => {
  const f = await workflowFixture();
  try {
    const art = f.inspection.candidates.find((c: { kind: string }) => c.kind === 'artwork');
    assert.ok(art);
    const response = await f.app.inject({
      method: 'POST',
      url: `${f.baseUrl}/suggestions`,
      headers: f.workerHeaders,
      payload: {
        sourceId: f.source.id,
        observations: [
          {
            sourceId: f.source.id,
            kind: 'missing-front-artwork',
            reason: 'Missing cover',
            evidenceIds: [...f.inspection.facts.evidenceIds, ...art.evidenceIds],
            candidateIds: [art.id],
          },
        ],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const page = await f.app.inject({
      url: `/api/v1/workflow-runs/${f.run.id}/proposals`,
      headers: f.auth,
    });
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(page.json().items.length, 1);
    const proposal = page.json().items[0];
    assert.equal(proposal.change.action, 'replace-front-artwork');
    assert.equal(proposal.version, 1);
    assert.deepEqual(f.catalog.sourceMatches(f.source.id).matches, []);
    await unlink(join(f.path, 'Game.png'));
    const url = `/api/v1/workflow-runs/${f.run.id}/sources/${f.source.id}/artifacts/${proposal.change.artifactId}`;
    const preview = await f.app.inject({ url, headers: f.auth });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.rawPayload, f.png);
    f.catalog.workflowRuns.cancelRun(f.run.id, f.owner.id);
    assert.equal((await f.app.inject({ url, headers: f.auth })).statusCode, 200);
    assert.equal(
      (await f.app.inject({ url: url.replace(f.run.id, 'another-run'), headers: f.auth }))
        .statusCode,
      404,
    );
    const forbidden = await f.app.inject({ url, headers: f.workerHeaders });
    assert.equal(forbidden.statusCode, 401);
    await f.close();
    const restored = await openServer({ dataDir: join(f.base, 'data') });
    try {
      const recovered = await restored.app.inject({ url, headers: f.auth });
      assert.equal(recovered.statusCode, 200, recovered.body);
      assert.deepEqual(recovered.rawPayload, f.png);
    } finally {
      await restored.close();
    }
  } finally {
    await f.dispose();
  }
});

test('concurrent materialization of the same reviewed candidate commits one immutable proposal version', async () => {
  const f = await workflowFixture();
  try {
    const art = f.inspection.candidates.find((c: { kind: string }) => c.kind === 'artwork');
    assert.ok(art);
    const evidenceIds = [...f.inspection.facts.evidenceIds, ...art.evidenceIds];
    const finding = f.catalog.workflowProposals.addFinding(f.run.id, {
      sourceId: f.source.id,
      kind: 'missing-front-artwork',
      ruleVersion: 'cleanup/1',
      currentValueDigest: f.inspection.facts.currentValueDigest,
      evidenceDigest: 'a'.repeat(64),
      reason: 'Missing cover',
      evidenceIds,
    });
    let reads = 0,
      releaseBoth!: () => void,
      releaseFirst!: () => void;
    const both = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const matching: Pick<SourceMatchingService, 'validateInspection' | 'readResource'> = {
      async validateInspection() {},
      async readResource() {
        const position = ++reads;
        if (position === 2) releaseBoth();
        await both;
        if (position === 2) {
          await firstDone;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return {
          bytes: f.png,
          contentType: 'image/png',
          fileName: 'cover.png',
          originKind: 'artwork',
        };
      },
    };
    const draft = {
      sourceId: f.source.id,
      findingId: finding.id,
      action: 'replace-front-artwork' as const,
      candidateId: art.id,
      evidenceIds,
      reason: 'Missing cover',
    };
    const context = { catalog: f.catalog } as ServerContext;
    const invoke = () =>
      materializeCleanupProposal(
        context,
        { ...f.run, state: 'running' },
        draft,
        matching,
        new AbortController().signal,
      ).then((result) => {
        releaseFirst();
        return result;
      });
    const first = invoke(),
      second = invoke();
    const values = await Promise.all([first, second]);
    assert.equal(values[0]?.version, 1);
    assert.deepEqual(values[1], values[0]);
    assert.equal(f.catalog.workflowProposals.pageProposals(f.run.id).items[0]?.version, 1);
  } finally {
    await f.dispose();
  }
});

test('only owners can keep or dismiss an exact scoped finding; proposal pages include live review state', async () => {
  const f = await workflowFixture();
  try {
    const facts = f.inspection.facts;
    const finding = f.catalog.workflowProposals.addFinding(f.run.id, {
      sourceId: f.source.id,
      kind: 'missing-front-artwork',
      ruleVersion: '1',
      currentValueDigest: facts.currentValueDigest,
      evidenceDigest: 'a'.repeat(64),
      reason: 'No saved cover',
      evidenceIds: facts.evidenceIds,
    });
    const url = `/api/v1/workflow-runs/${f.run.id}/findings/${finding.id}/decision`;
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url,
          headers: f.workerHeaders,
          payload: { decision: 'dismiss' },
        })
      ).statusCode,
      401,
    );
    for (const decision of ['keep', 'dismiss']) {
      const response = await f.app.inject({
        method: 'POST',
        url,
        headers: f.auth,
        payload: { decision },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().finding.dismissed, true);
    }
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: url.replace(f.run.id, 'other-run'),
          headers: f.auth,
          payload: { decision: 'keep' },
        })
      ).statusCode,
      404,
    );
    const findings = await f.app.inject({
      url: `/api/v1/workflow-runs/${f.run.id}/findings`,
      headers: f.auth,
    });
    assert.equal(findings.json().items[0].dismissed, true);
  } finally {
    await f.dispose();
  }
});
