import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WorkflowWorkerPool } from '../src/workflows/worker.js';

const snapshot = { input: {}, checkpoint: null, completed: {} };

test('workflow workers strip parent credentials and reject malformed output without echoing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-workflow-worker-'));
  const pool = new WorkflowWorkerPool();
  const original = process.env.ECS_TOKEN;
  process.env.ECS_TOKEN = 'generated-parent-credential';
  try {
    const entry = join(directory, 'workflow.mjs');
    await writeFile(
      entry,
      "export default {advance(){ console.log('ignored plugin output'); return {state:'completed',checkpoint:null,operations:[],output:{hasCredential:!!process.env.ECS_TOKEN}}; }};",
    );
    const result = await pool.invoke(entry, 'advance', snapshot);
    assert.equal((result as { output: { hasCredential: boolean } }).output.hasCredential, false);
    const broken = join(directory, 'broken.mjs');
    await writeFile(
      broken,
      "export default {advance(){ throw new Error('generated-private-message'); }};",
    );
    await assert.rejects(
      pool.invoke(broken, 'advance', snapshot),
      (error: unknown) =>
        error instanceof Error && !error.message.includes('generated-private-message'),
    );
    const invalid = join(directory, 'invalid.mjs');
    await writeFile(
      invalid,
      "export default {advance(){ return {state:'completed',checkpoint:NaN,operations:[]}; }};",
    );
    await assert.rejects(pool.invoke(invalid, 'advance', snapshot));
    await assert.rejects(
      pool.invoke(entry, 'advance', snapshot, {
        scope: 'connection',
        context: { credentials: { apiKey: 'generated-key' } },
      }),
    );
  } finally {
    if (original === undefined) delete process.env.ECS_TOKEN;
    else process.env.ECS_TOKEN = original;
    await pool.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('workflow worker deadlines retire hung processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-workflow-deadline-'));
  const pool = new WorkflowWorkerPool();
  try {
    const marker = join(directory, 'started');
    const entry = join(directory, 'hung.mjs');
    await writeFile(
      entry,
      `import {writeFileSync} from 'node:fs';export default {async advance(){writeFileSync(${JSON.stringify(marker)},'started');await new Promise(()=>{});}};`,
    );
    await assert.rejects(pool.invoke(entry, 'advance', snapshot, { timeoutMs: 3000 }), /deadline/);
    assert.equal(await readFile(marker, 'utf8'), 'started');
  } finally {
    await pool.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('workflow execution allows two workers and bounds its queue at sixty-four requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-workflow-queue-'));
  const pool = new WorkflowWorkerPool();
  const abort = new AbortController();
  try {
    const entry = join(directory, 'waiting.mjs');
    await writeFile(entry, 'export default {async advance(){await new Promise(()=>{});}};');
    const accepted = Array.from({ length: 66 }, () =>
      pool.invoke(entry, 'advance', snapshot, { signal: abort.signal, timeoutMs: 10_000 }),
    );
    const settled = Promise.allSettled(accepted);
    await assert.rejects(
      pool.invoke(entry, 'advance', snapshot, { signal: abort.signal }),
      /queue/,
    );
    abort.abort();
    const results = await settled;
    assert.equal(results.length, 66);
    assert.ok(results.every((result) => result.status === 'rejected'));
  } finally {
    abort.abort();
    await pool.close();
    await rm(directory, { recursive: true, force: true });
  }
});
