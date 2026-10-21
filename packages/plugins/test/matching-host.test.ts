import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { matchingJob } from '../src/matching-host.js';

test('installed provider and manager run outside the caller without inheriting bearer credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-match-'));
  const secretBefore = process.env.ECS_TOKEN;
  process.env.ECS_TOKEN = 'test-secret-never-passed';
  try {
    for (const [id, kind, config, code] of [
      [
        'test.provider',
        'provider',
        { capabilities: ['metadata'], network: false },
        `export default { search: async () => [{id:'one',kind:'metadata',title:process.env.ECS_TOKEN ? 'LEAK' : 'Isolated',confidence:'local',metadata:{pid:String(process.pid)}}] };`,
      ],
      [
        'test.manager',
        'manager',
        { providers: ['test.provider'] },
        `export default { selectProviders: () => ['test.provider'] };`,
      ],
    ] as const) {
      const dir = join(directory, id);
      await mkdir(dir);
      await writeFile(
        join(dir, 'plugin.json'),
        JSON.stringify({
          id,
          name: id,
          version: '1',
          kind,
          engine: 'ecs.plugin/1',
          entry: 'entry.mjs',
          [kind]: config,
        }),
      );
      await writeFile(join(dir, 'entry.mjs'), code);
    }
    const result = await matchingJob({
      operation: 'match',
      directory,
      managerId: 'test.manager',
      input: { name: 'Game.rom', systemId: null, companions: [] },
    });
    assert.equal(result.result?.candidates[0]?.title, 'Isolated');
    assert.notEqual(result.result?.candidates[0]?.metadata.pid, String(process.pid));
    assert.equal(result.result?.candidates[0]?.providerId, 'test.provider');
    const list = await matchingJob({ operation: 'list', directory });
    assert.ok(list.plugins.some((p) => p.id === 'test.manager' && p.kind === 'manager'));
  } finally {
    if (secretBefore === undefined) delete process.env.ECS_TOKEN;
    else process.env.ECS_TOKEN = secretBefore;
    await rm(directory, { recursive: true, force: true });
  }
});

test('hung installed code is terminated by the process boundary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-match-hang-'));
  try {
    const dir = join(directory, 'hung');
    await mkdir(dir);
    await writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify({
        id: 'test.hung',
        name: 'Hung',
        version: '1',
        kind: 'provider',
        engine: 'ecs.plugin/1',
        entry: 'entry.mjs',
        provider: { capabilities: ['metadata'], network: false },
      }),
    );
    await writeFile(join(dir, 'entry.mjs'), 'while(true){}');
    await assert.rejects(
      matchingJob(
        {
          operation: 'match',
          directory,
          input: { name: 'Game.rom', systemId: null, companions: [] },
        },
        { timeoutMs: 800 },
      ),
      /timed out/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('caller cancellation terminates installed matching work promptly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-match-abort-'));
  try {
    const dir = join(directory, 'hung');
    await mkdir(dir);
    await writeFile(
      join(dir, 'plugin.json'),
      JSON.stringify({
        id: 'test.hung',
        name: 'Hung',
        version: '1',
        kind: 'provider',
        engine: 'ecs.plugin/1',
        entry: 'entry.mjs',
        provider: { capabilities: ['metadata'], network: false },
      }),
    );
    await writeFile(join(dir, 'entry.mjs'), 'export default {search:async()=>new Promise(()=>{})}');
    const abort = new AbortController();
    const pending = matchingJob(
      {
        operation: 'match',
        directory,
        input: { name: 'Game.rom', systemId: null, companions: [] },
      },
      { signal: abort.signal },
    );
    abort.abort();
    await assert.rejects(pending, /cancelled/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
