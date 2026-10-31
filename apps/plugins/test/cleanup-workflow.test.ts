import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateWorkflowPlan } from '@ecs/plugins/workflows';
import type { WorkflowCatalogResult } from '@ecs/protocol';
import { installBundledCleanup } from '../src/workflows/bundled.js';
import { advance } from '../src/workflows/cleanup/workflow.js';
import { resolveWorkflowPackage } from '../src/workflows/packages.js';
import { startWorkflowHost } from '../src/workflows/transport.js';

const facts: WorkflowCatalogResult['facts'] = {
  sourceId: 'source-1',
  name: 'Generated Game.nes',
  systemId: 'com.provenance.nes',
  sourceValidator: 'a'.repeat(64),
  selectionRevision: 0,
  currentValueDigest: 'b'.repeat(64),
  selected: [],
  evidenceIds: ['fact-1'],
};
function inspect(value: Partial<WorkflowCatalogResult> = {}) {
  const result: WorkflowCatalogResult = {
    facts,
    candidates: [],
    problems: [],
    supportedIdentity: false,
    ...value,
  };
  return advance({
    input: { source: { sourceId: facts.sourceId } },
    checkpoint: null,
    completed: { inspect: { state: 'completed', output: result as never } },
  });
}

test('cleanup requests one read-only catalog step and reports missing front artwork with unresolved identity', async () => {
  const first = await advance({
    input: { source: { sourceId: facts.sourceId } },
    checkpoint: null,
    completed: {},
  });
  assert.deepEqual(first.operations, [
    {
      id: 'inspect',
      binding: 'catalog',
      capability: 'catalog.search',
      major: 1,
      input: { sourceId: facts.sourceId },
    },
  ]);
  const done = await inspect();
  assert.equal(done.observations?.[0]?.kind, 'missing-front-artwork');
  assert.deepEqual(done.proposals, []);
  assert.match(JSON.stringify(done.output), /unsupported/);
});

test('back-only artwork does not satisfy a front cover; unavailable front art is distinct', async () => {
  const selected = {
    id: 'saved-art',
    kind: 'artwork',
    title: 'Generated',
    systemId: null,
    artworkRole: 'back',
    contentAvailable: true,
    identityConflict: false,
  };
  assert.equal(
    (await inspect({ facts: { ...facts, selected: [selected] } })).observations?.[0]?.kind,
    'missing-front-artwork',
  );
  assert.equal(
    (
      await inspect({
        facts: {
          ...facts,
          selected: [{ ...selected, artworkRole: 'front', contentAvailable: false }],
        },
      })
    ).observations?.[0]?.kind,
    'unavailable-selected-artwork',
  );
});

test('cleanup bounds materialized alternatives and includes only relevant evidence references', async () => {
  const candidates = Array.from({ length: 150 }, (_, i) => ({
    id: `candidate-${i}`,
    kind: 'artwork',
    title: `Generated ${i}`,
    systemId: null,
    artworkRole: 'front',
    providerId: 'org.example.catalog',
    evidenceClass: 'filename' as const,
    identityConflict: false,
    agreesWithSelection: false,
    evidenceIds: [`evidence-${i}`],
  }));
  const done = await inspect({ candidates });
  assert.ok((done.observations?.flatMap((o) => o.candidateIds).length ?? 0) <= 10);
  assert.doesNotThrow(() => validateWorkflowPlan(done));
});

test('identity conflicts, weaker filename evidence and provider failures remain reviewable findings', async () => {
  const candidate = {
    id: 'candidate-1',
    kind: 'metadata',
    title: 'Other edition',
    systemId: 'com.provenance.nes',
    artworkRole: null,
    providerId: 'org.example.catalog',
    evidenceClass: 'verified-source' as const,
    identityConflict: true,
    agreesWithSelection: false,
    evidenceIds: ['catalog-1'],
  };
  const conflicting = await inspect({
    supportedIdentity: true,
    candidates: [candidate],
    facts: {
      ...facts,
      selected: [
        {
          id: 'saved',
          kind: 'metadata',
          title: 'Wrong',
          systemId: 'com.provenance.nes',
          artworkRole: null,
          contentAvailable: false,
          identityConflict: true,
        },
      ],
    },
  });
  assert.ok(conflicting.observations?.some((o) => o.kind === 'identity-conflict'));
  assert.deepEqual(conflicting.proposals, []);
  const failed = await inspect({
    candidates: [{ ...candidate, identityConflict: false, evidenceClass: 'filename' }],
    problems: [{ providerId: 'org.example.down', code: 'provider-failed' }],
  });
  assert.deepEqual(failed.proposals, []);
  assert.match(JSON.stringify(failed.output), /provider-failed/);
  const clean = await inspect({
    supportedIdentity: true,
    facts: {
      ...facts,
      selected: [
        {
          id: 'front',
          kind: 'artwork',
          title: 'Generated',
          systemId: null,
          artworkRole: 'front',
          contentAvailable: true,
          identityConflict: false,
        },
      ],
    },
    candidates: [],
  });
  assert.deepEqual(clean.observations, []);
});

test('the bundled cleanup executes through the installed module runtime and publishes a no-key finding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-bundled-cleanup-'));
  const controller = new AbortController();
  try {
    const installed = await installBundledCleanup(dir);
    assert.equal(
      (await resolveWorkflowPackage(dir, installed.manifest.id)).digest,
      installed.digest,
    );
    let claimed = false,
      complete = false,
      inspections = 0,
      suggestions = 0;
    const run = {
      id: 'run-1',
      hostId: 'host-1',
      actorId: 'owner-1',
      workflowId: installed.manifest.id,
      workflowDigest: installed.digest,
      scope: { libraryId: 'library-1' },
      options: { online: false, checksum: false, shareImages: false },
      state: 'running',
      revision: 1,
      total: 1,
      processed: 0,
      createdAt: '2030-01-01T00:00:00Z',
      updatedAt: '2030-01-01T00:00:00Z',
      error: null,
    };
    const lease = {
      runId: run.id,
      hostId: run.hostId,
      fence: 1,
      expiresAt: '2030-01-01T00:01:00Z',
    };
    const client = {
      async advertiseWorkflowHost() {
        return {};
      },
      async claimWorkflowRun() {
        if (claimed) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {};
        }
        claimed = true;
        return { run, lease };
      },
      async heartbeatWorkflowRun() {
        return { lease };
      },
      async workflowWork() {
        return {
          items: complete
            ? []
            : [
                {
                  sourceId: 'source-1',
                  indexValidator: 'generated',
                  selectionRevision: 0,
                  state: 'pending',
                },
              ],
          nextCursor: null,
        };
      },
      async searchWorkflowCatalog() {
        inspections++;
        return { facts, candidates: [], problems: [], supportedIdentity: false };
      },
      async submitWorkflowSuggestions(_run: string, _source: string, observations: unknown[]) {
        suggestions += observations.length;
        return { findings: [] };
      },
      async publishWorkflowRun(
        _lease: unknown,
        publication: { completedSourceIds: string[]; state?: string },
      ) {
        if (publication.completedSourceIds.length) complete = true;
        if (publication.state === 'completed') controller.abort();
        return { run };
      },
      async interruptWorkflowRun() {
        throw new Error('Unexpected interruption');
      },
    };
    const errors: string[] = [];
    const timeout = setTimeout(() => controller.abort(), 10_000);
    await startWorkflowHost(
      {
        stateDirectory: dir,
        server: 'http://127.0.0.1:8473',
        client: client as never,
        log(message) {
          errors.push(message);
          controller.abort();
        },
        async pause() {
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      },
      controller.signal,
    );
    clearTimeout(timeout);
    assert.deepEqual(errors, []);
    assert.equal(inspections, 1);
    assert.equal(suggestions, 1);
    assert.equal(complete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
