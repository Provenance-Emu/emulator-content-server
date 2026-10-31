import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openWorkflowState } from '../src/workflows/state.js';
import { readWorkflowCredential, startWorkflowHost } from '../src/workflows/transport.js';

test('host credentials require private files and are never accepted in URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-host-secret-'));
  try {
    const path = join(dir, 'credential');
    await writeFile(path, 'generated-service-token\n', { mode: 0o600 });
    assert.equal(await readWorkflowCredential(path), 'generated-service-token');
    if (process.platform !== 'win32') {
      await chmod(path, 0o644);
      await assert.rejects(readWorkflowCredential(path), /private/);
    }
    await assert.rejects(
      startWorkflowHost(
        { stateDirectory: dir, server: 'http://user:secret@localhost', credentialFile: path },
        new AbortController().signal,
      ),
      /server URL/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('host polling backs off and shutdown releases its private state lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-host-loop-'));
  const controller = new AbortController();
  let claims = 0;
  const pauses: number[] = [];
  const client = {
    async advertiseWorkflowHost() {
      return {};
    },
    async claimWorkflowRun() {
      claims++;
      throw new Error('Generated unavailable');
    },
  };
  try {
    await startWorkflowHost(
      {
        stateDirectory: dir,
        server: 'http://127.0.0.1:8473',
        client: client as never,
        async pause(ms) {
          pauses.push(ms);
          if (pauses.length === 3) controller.abort();
        },
      },
      controller.signal,
    );
    assert.equal(claims, 3);
    assert.deepEqual(pauses, [250, 500, 1000]);
    const state = await openWorkflowState(dir);
    state.close();
    await startWorkflowHost(
      { stateDirectory: dir, server: 'http://127.0.0.1:8473', client: client as never },
      controller.signal,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second host cannot schedule operations from the same private state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-host-exclusive-'));
  const controller = new AbortController();
  let ready!: () => void, finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const client = {
    async advertiseWorkflowHost() {
      return {};
    },
    async claimWorkflowRun() {
      ready();
      await blocked;
      return {};
    },
  };
  const options = { stateDirectory: dir, server: 'http://127.0.0.1:8473', client: client as never };
  const first = startWorkflowHost(options, controller.signal);
  try {
    await entered;
    await assert.rejects(
      startWorkflowHost(options, new AbortController().signal),
      /already running/,
    );
  } finally {
    controller.abort();
    finish();
    await first;
    await rm(dir, { recursive: true, force: true });
  }
});
