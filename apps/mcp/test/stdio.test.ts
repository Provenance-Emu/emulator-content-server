import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openServer } from '@ecs/server';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('a stdio client sends an evidence-backed proposal to the owner review queue', {
  timeout: 30_000,
}, async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'ecs-mcp-')));
  const ecs = await openServer({ dataDir: join(base, 'data'), automaticMatching: false });
  const client = new Client({ name: 'ecs-test-assistant', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await ecs.close();
    await rm(base, { recursive: true, force: true });
  });
  const token = randomBytes(32).toString('base64url');
  ecs.catalog.saveBootstrapHash(createHash('sha256').update(token).digest('hex'));
  const bootstrap = await ecs.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token, username: 'owner', password: 'correct-horse' },
  });
  assert.equal(bootstrap.statusCode, 201);
  const owner = ecs.catalog.listUsers()[0];
  assert.ok(owner);
  const headers = { authorization: `Bearer ${bootstrap.json().token}` };
  const { id: libraryId } = ecs.catalog.createLibrary(owner.id, 'MCP shelf');
  const folder = join(base, 'games');
  await mkdir(folder);
  await writeFile(join(folder, 'Generated.j64'), Buffer.from([1, 2, 3, 4]));
  await writeFile(
    join(folder, 'Generated.json'),
    JSON.stringify({ title: 'Local generated title' }),
  );
  const root = ecs.catalog.createContentRoot({
    path: folder,
    label: 'Games',
    libraryId,
    actorId: owner.id,
  });
  assert.equal(
    (await ecs.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers }))
      .statusCode,
    200,
  );
  const grant = await ecs.app.inject({
    method: 'POST',
    url: '/api/v1/investigators',
    headers,
    payload: {
      libraryIds: [libraryId],
      operations: ['inspect', 'cleanup', 'suggest'],
      ttlSeconds: 120,
    },
  });
  assert.equal(grant.statusCode, 201);
  const credentialFile = join(base, 'token');
  await writeFile(credentialFile, grant.json().token, { mode: 0o600 });
  const serverUrl = await ecs.app.listen({ host: '127.0.0.1', port: 0 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/main.js', import.meta.url)), serverUrl, credentialFile],
    stderr: 'pipe',
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'ecs_suggest'));
  assert.equal(
    tools.some((tool) => /apply|approve|install|shell/.test(tool.name)),
    false,
  );
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.ok(result.structuredContent);
    return result.structuredContent;
  }
  const sources = (await call('ecs_sources', { libraryId })) as { items: { id: string }[] };
  const sourceId = sources.items[0]?.id;
  assert.ok(sourceId);
  const started = (await call('ecs_start_cleanup', { libraryId, sourceIds: [sourceId] })) as {
    run: { id: string };
  };
  const runId = started.run.id;
  const inspection = (await call('ecs_inspect_source', { runId, sourceId })) as {
    candidates: { id: string; kind: string; evidenceIds: string[] }[];
  };
  const candidate = inspection.candidates.find((item) => item.kind === 'metadata');
  assert.ok(candidate);
  const submitted = (await call('ecs_suggest', {
    runId,
    sourceId,
    kind: 'suspected-mismatch',
    reason: 'Review the local title.',
    candidateIds: [candidate.id],
    evidenceIds: candidate.evidenceIds,
  })) as { proposals: { id: string; version: number; digest: string }[] };
  const review = await ecs.app.inject({ url: `/api/v1/workflow-runs/${runId}/proposals`, headers });
  assert.equal(review.statusCode, 200);
  const { id, version, digest } = review.json().items[0];
  assert.deepEqual(
    submitted.proposals.map((proposal) => ({
      id: proposal.id,
      version: proposal.version,
      digest: proposal.digest,
    })),
    [{ id, version, digest }],
  );
  const finished = (await call('ecs_finish_cleanup', { runId })) as { run: { state: string } };
  assert.equal(finished.run.state, 'completed');
  const ownerRun = await ecs.app.inject({ url: `/api/v1/workflow-runs/${runId}`, headers });
  assert.equal(ownerRun.json().run.processed, 1);
});
