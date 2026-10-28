import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { matchingJob } from '../src/matching-host.js';

type WorkerScope = { directory?: string; catalogCacheDirectory?: string };
async function closeWorkers(scope?: WorkerScope) {
  const host = await import('../src/matching-host.js');
  await (
    host as { closeMatchingWorkers?: (scope?: WorkerScope) => Promise<void> }
  ).closeMatchingWorkers?.(scope);
}
afterEach(() => closeWorkers());

test('oversized input is rejected before creating a worker', async () => {
  await assert.rejects(
    matchingJob({ operation: 'list', artworkUrl: 'x'.repeat(512 * 1024) }),
    /input too large/,
  );
});

test('malformed IPC retires its worker and cannot satisfy the next queued request', async () => {
  const { directory, job } = await fixture(`export default {search:async input=>{
    if(input.name==='forged'){process.send({id:'00000000-0000-0000-0000-000000000000',reply:{plugins:[]},recycle:false});await new Promise(()=>{});}
    return [{id:'one',kind:'metadata',title:input.name,confidence:'local',metadata:{pid:String(process.pid)}}];
  }};`);
  try {
    const invalid = assert.rejects(matchingJob(job('forged')), /invalid data/);
    const next = matchingJob(job('healthy'));
    await invalid;
    assert.equal((await next).result?.candidates[0]?.title, 'healthy');
  } finally {
    await closeWorkers({ directory });
    await rm(directory, { recursive: true, force: true });
  }
});

test('worker bounds normal IPC output before sending it and healthy work recovers', async () => {
  const { directory, job } =
    await fixture(`export default {search:async input=> input.name==='large'
    ? Array.from({length:100},(_,i)=>({id:String(i),kind:'metadata',title:'Large',confidence:'local',metadata:Object.fromEntries(Array.from({length:24},(_,j)=>['k'+j,'x'.repeat(4096)]))}))
    : [{id:'one',kind:'metadata',title:input.name,confidence:'local',metadata:{pid:String(process.pid)}}]};`);
  try {
    await assert.rejects(matchingJob(job('large')), /host stopped/);
    assert.equal((await matchingJob(job('healthy'))).result?.candidates[0]?.title, 'healthy');
  } finally {
    await closeWorkers({ directory });
    await rm(directory, { recursive: true, force: true });
  }
});

test('pending queue is bounded and shutting down rejects every queued request', async () => {
  const marker = join(tmpdir(), `ecs-match-cap-${process.pid}-${Date.now()}`);
  const { directory, job } =
    await fixture(`import {writeFile} from 'node:fs/promises';export default {search:async()=>{
    await writeFile(${JSON.stringify(marker)},String(process.pid));await new Promise(()=>{});
  }};`);
  try {
    const active = assert.rejects(matchingJob(job('active')), /clos/);
    await started(marker);
    const queued = Array.from({ length: 64 }, () =>
      assert.rejects(matchingJob(job('queued')), /clos/),
    );
    await assert.rejects(matchingJob(job('overflow')), /queue full/);
    await closeWorkers({ directory });
    await Promise.all([active, ...queued]);
  } finally {
    await closeWorkers({ directory });
    await rm(directory, { recursive: true, force: true });
    await rm(marker, { force: true });
  }
});

test('a queued deadline expires without terminating the healthy active worker', async () => {
  const marker = join(tmpdir(), `ecs-match-queued-deadline-${process.pid}-${Date.now()}`);
  const { directory, job } =
    await fixture(`import {writeFile} from 'node:fs/promises';export default {search:async input=>{
    if(input.name==='active'){await writeFile(${JSON.stringify(marker)},String(process.pid));await new Promise(r=>setTimeout(r,200));}
    return [{id:'one',kind:'metadata',title:input.name,confidence:'local',metadata:{pid:String(process.pid)}}];
  }};`);
  try {
    const active = matchingJob(job('active'));
    await started(marker);
    await assert.rejects(matchingJob(job('expired'), { timeoutMs: 30 }), /timed out/);
    const next = matchingJob(job('next'));
    const [a, b] = await Promise.all([active, next]);
    assert.equal(a.result?.candidates[0]?.metadata.pid, b.result?.candidates[0]?.metadata.pid);
  } finally {
    await closeWorkers({ directory });
    await rm(directory, { recursive: true, force: true });
    await rm(marker, { force: true });
  }
});

test('pool admits at most two scopes and scoped shutdown preserves the other active server', async () => {
  const markers = await mkdtemp(join(tmpdir(), 'ecs-match-scopes-'));
  const fixtures = await Promise.all(
    [0, 1, 2].map((i) =>
      fixture(`import {writeFile} from 'node:fs/promises';export default {search:async input=>{
    await writeFile(${JSON.stringify(join(markers, String(i)))},String(process.pid));
    if(input.name==='hang')await new Promise(()=>{});if(input.name==='slow')await new Promise(r=>setTimeout(r,200));
    return [{id:'one',kind:'metadata',title:input.name,confidence:'local',metadata:{pid:String(process.pid)}}];
  }};`),
    ),
  );
  const [a, b, c] = fixtures;
  assert.ok(a && b && c);
  try {
    const first = assert.rejects(matchingJob(a.job('hang')), /clos/);
    const second = matchingJob(b.job('slow'));
    const firstPid = await started(join(markers, '0')),
      secondPid = await started(join(markers, '1'));
    assert.notEqual(firstPid, secondPid);
    const third = matchingJob(c.job('third'));
    await delay(30);
    await assert.rejects(readFile(join(markers, '2')), { code: 'ENOENT' });
    await closeWorkers({ directory: a.directory });
    await first;
    const [secondReply, thirdReply] = await Promise.all([second, third]);
    assert.equal(secondReply.result?.candidates[0]?.metadata.pid, String(secondPid));
    assert.equal(thirdReply.result?.candidates[0]?.title, 'third');
  } finally {
    await closeWorkers();
    await Promise.all(fixtures.map((f) => rm(f.directory, { recursive: true, force: true })));
    await rm(markers, { recursive: true, force: true });
  }
});

test('idle workers expire and a subsequent request starts a fresh process', async () => {
  const { directory, job } = await fixture(
    `export default {search:async input=>[{id:'one',kind:'metadata',title:input.name,confidence:'local',metadata:{pid:String(process.pid)}}]};`,
  );
  try {
    const pid = Number((await matchingJob(job('first'))).result?.candidates[0]?.metadata.pid);
    for (let i = 0; i < 70; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await delay(100);
    }
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.notEqual(
      (await matchingJob(job('second'))).result?.candidates[0]?.metadata.pid,
      String(pid),
    );
  } finally {
    await closeWorkers({ directory });
    await rm(directory, { recursive: true, force: true });
  }
});

test('worker is recycled after its bounded job budget', async () => {
  const { directory, job } = await fixture(
    `let calls=0;export default {search:async input=>[{id:'one',kind:'metadata',title:input.name,confidence:'local',metadata:{pid:String(process.pid),calls:String(++calls)}}]};`,
  );
  try {
    const first = (await matchingJob(job('first'))).result?.candidates[0];
    let final = first;
    for (let i = 1; i <= 2048; i++) final = (await matchingJob(job('next'))).result?.candidates[0];
    assert.notEqual(final?.metadata.pid, first?.metadata.pid);
    assert.equal(final?.metadata.calls, '1');
  } finally {
    await closeWorkers({ directory });
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(code: string) {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-match-pool-'));
  const plugin = join(directory, 'provider');
  await mkdir(plugin);
  await writeFile(
    join(plugin, 'plugin.json'),
    JSON.stringify({
      id: 'test.pool',
      name: 'Pool fixture',
      kind: 'provider',
      version: '1',
      engine: 'ecs.plugin/1',
      entry: 'entry.mjs',
      provider: { capabilities: ['metadata'], network: false },
    }),
  );
  await writeFile(join(plugin, 'entry.mjs'), code);
  return {
    directory,
    job: (name: string) => ({
      operation: 'match' as const,
      directory,
      providerIds: ['test.pool'],
      input: { name, systemId: null, companions: [] },
    }),
  };
}

async function started(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return Number(await readFile(path, 'utf8'));
    } catch {
      await delay(20);
    }
  }
  throw new Error('Provider did not start');
}

test('matching worker is reused and invokes one provider job at a time', async () => {
  const { directory, job } = await fixture(`
    let calls=0, active=0;
    export default { search: async (input) => {
      const call=++calls; const overlap=++active;
      await new Promise(r=>setTimeout(r,40)); active--;
      return [{id:'one',kind:'metadata',title:input.name,confidence:'local',metadata:{pid:String(process.pid),calls:String(call),active:String(overlap),heap:process.execArgv.join(' ')}}];
    }};`);
  try {
    const [first, second] = await Promise.all([
      matchingJob(job('first')),
      matchingJob(job('second')),
    ]);
    const a = first.result?.candidates[0],
      b = second.result?.candidates[0];
    assert.equal(a?.metadata.pid, b?.metadata.pid);
    assert.equal(a?.metadata.calls, '1');
    assert.equal(b?.metadata.calls, '2');
    assert.equal(a?.metadata.active, '1');
    assert.equal(b?.metadata.active, '1');
    assert.match(a?.metadata.heap ?? '', /max-old-space-size=192/);
  } finally {
    await closeWorkers({ directory });
    await rm(directory, { recursive: true, force: true });
  }
});

test('aborted active worker cannot answer the next queued job and is replaced', async () => {
  const marker = join(tmpdir(), `ecs-match-start-${process.pid}-${Date.now()}`);
  const { directory, job } = await fixture(`
    import {writeFile} from 'node:fs/promises';
    export default {search: async input=>{
      if(input.name==='old'){await writeFile(${JSON.stringify(marker)},String(process.pid));await new Promise(r=>setTimeout(r,200));}
      return [{id:'one',kind:'metadata',title:input.name,confidence:'local',metadata:{pid:String(process.pid)}}];
    }};`);
  try {
    const abort = new AbortController();
    const old = matchingJob(job('old'), { signal: abort.signal });
    const rejected = assert.rejects(old, /cancelled/);
    const next = matchingJob(job('next'));
    const pid = await started(marker);
    abort.abort();
    await rejected;
    const result = (await next).result?.candidates[0];
    assert.equal(result?.title, 'next');
    assert.notEqual(result?.metadata.pid, String(pid));
  } finally {
    await closeWorkers({ directory });
    await rm(directory, { recursive: true, force: true });
    await rm(marker, { force: true });
  }
});

test('queued cancellation preserves the active worker and the following FIFO request', async () => {
  const marker = join(tmpdir(), `ecs-match-fifo-${process.pid}-${Date.now()}`);
  const { directory, job } = await fixture(`
    import {writeFile} from 'node:fs/promises'; let calls=0;
    export default {search: async input=>{
      calls++; if(input.name==='first'){await writeFile(${JSON.stringify(marker)},String(process.pid));await new Promise(r=>setTimeout(r,150));}
      return [{id:'one',kind:'metadata',title:input.name,confidence:'local',metadata:{pid:String(process.pid),calls:String(calls)}}];
    }};`);
  try {
    const first = matchingJob(job('first'));
    await started(marker);
    const abort = new AbortController();
    const second = matchingJob(job('cancel'), { signal: abort.signal });
    const rejected = assert.rejects(second, /cancelled/);
    const third = matchingJob(job('third'));
    abort.abort();
    await rejected;
    const [a, b] = await Promise.all([first, third]);
    assert.equal(a.result?.candidates[0]?.metadata.pid, b.result?.candidates[0]?.metadata.pid);
    assert.equal(b.result?.candidates[0]?.metadata.calls, '2');
  } finally {
    await closeWorkers({ directory });
    await rm(directory, { recursive: true, force: true });
    await rm(marker, { force: true });
  }
});

test('worker deadline kills hung code and queued healthy work recovers', async () => {
  const { directory, job } = await fixture(`export default {search:async input=>{
    if(input.name==='hang')while(true){}
    return [{id:'one',kind:'metadata',title:input.name,confidence:'local',metadata:{pid:String(process.pid)}}];
  }};`);
  try {
    const hung = matchingJob(job('hang'), { timeoutMs: 800 });
    const rejected = assert.rejects(hung, /timed out/);
    const healthy = matchingJob(job('recovered'), { timeoutMs: 4000 });
    await rejected;
    assert.equal((await healthy).result?.candidates[0]?.title, 'recovered');
  } finally {
    await closeWorkers({ directory });
    await rm(directory, { recursive: true, force: true });
  }
});

test('scoped shutdown rejects active and queued work, kills its worker, and permits a fresh worker', async () => {
  const marker = join(tmpdir(), `ecs-match-close-${process.pid}-${Date.now()}`);
  const { directory, job } = await fixture(`import {writeFile} from 'node:fs/promises';
    export default {search:async input=>{
      if(input.name==='hang'){await writeFile(${JSON.stringify(marker)},String(process.pid));await new Promise(()=>{});}
      return [{id:'one',kind:'metadata',title:input.name,confidence:'local',metadata:{pid:String(process.pid)}}];
    }};`);
  try {
    const active = matchingJob(job('hang'));
    const rejectedActive = assert.rejects(active, /clos/);
    const queued = matchingJob(job('queued'));
    const rejectedQueue = assert.rejects(queued, /clos/);
    const pid = await started(marker);
    await closeWorkers({ directory });
    await Promise.all([rejectedActive, rejectedQueue]);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.notEqual(
      (await matchingJob(job('new'))).result?.candidates[0]?.metadata.pid,
      String(pid),
    );
  } finally {
    await closeWorkers({ directory });
    await rm(directory, { recursive: true, force: true });
    await rm(marker, { force: true });
  }
});

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

test('provider that ignores its own deadline is retired before another job can overlap it', async () => {
  const marker = join(tmpdir(), `ecs-match-provider-deadline-${process.pid}-${Date.now()}`);
  const { directory, job } =
    await fixture(`import {writeFile} from 'node:fs/promises';export default {search:async input=>{
    if(input.name==='ignore'){await writeFile(${JSON.stringify(marker)},String(process.pid));await new Promise(()=>{});}
    return [{id:'one',kind:'metadata',title:input.name,confidence:'local',metadata:{pid:String(process.pid)}}];
  }};`);
  try {
    const first = matchingJob(job('ignore'), { timeoutMs: 12000 });
    const pid = await started(marker);
    const second = matchingJob(job('healthy'), { timeoutMs: 12000 });
    assert.deepEqual((await first).result?.problems, [
      { providerId: 'test.pool', code: 'provider-failed' },
    ]);
    const result = (await second).result?.candidates[0];
    assert.equal(result?.title, 'healthy');
    assert.notEqual(result?.metadata.pid, String(pid));
  } finally {
    await closeWorkers({ directory });
    await rm(directory, { recursive: true, force: true });
    await rm(marker, { force: true });
  }
});
