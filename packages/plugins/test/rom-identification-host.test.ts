import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { closeMatchingWorkers, matchingJob } from '../src/matching-host.js';

async function fixture(code: string) {
  const base = await mkdtemp(join(tmpdir(), 'ecs-identification-host-'));
  const directory = join(base, 'plugins');
  await mkdir(join(directory, 'identity'), { recursive: true });
  await writeFile(
    join(directory, 'identity', 'plugin.json'),
    JSON.stringify({
      id: 'test.identity',
      name: 'Generated identifier',
      kind: 'provider',
      version: '1',
      engine: 'ecs.plugin/1',
      entry: 'entry.mjs',
      provider: { capabilities: ['rom'], network: false },
    }),
  );
  await writeFile(join(directory, 'identity', 'entry.mjs'), code);
  const path = join(base, 'generated.data');
  await writeFile(path, Buffer.from([1, 2, 3, 4]));
  return {
    base,
    directory,
    path,
    async dispose() {
      await closeMatchingWorkers({ directory });
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('installed offline provider can contribute bounded identification facts in the worker', async () => {
  const f = await fixture(
    `export default {identify:async(request,reader)=>{const bytes=await reader.read(0,4);return {version:1,pluginIds:['test.identity'],hashes:[],identifiers:[{type:'serial',value:'TEST-0001',systemId:'com.provenance.dreamcast',verified:bytes[0]===1}],names:[],warnings:[]};}};`,
  );
  try {
    const reply = await matchingJob({
      operation: 'identify',
      directory: f.directory,
      identification: { path: f.path, name: 'generated.data', size: 4, systemId: null },
    });
    assert.ok(reply.facts?.identifiers.some((id) => id.value === 'TEST-0001' && id.verified));
    assert.ok(!JSON.stringify(reply).includes(f.base));
  } finally {
    await f.dispose();
  }
});

test('cancelling identification retires the whole native reader process group', {
  skip: process.platform === 'win32',
}, async () => {
  const f = await fixture(
    `export default {identify:async(request,reader)=>{await reader.runTool('sevenZip',['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",request.path+'.child'],{maxStdoutBytes:1024,timeoutMs:20000});return {version:1,pluginIds:['test.identity'],hashes:[],identifiers:[],names:[],warnings:[]};}};`,
  );
  try {
    const abort = new AbortController();
    const pending = assert.rejects(
      matchingJob(
        {
          operation: 'identify',
          directory: f.directory,
          identification: {
            path: f.path,
            name: 'generated.data',
            size: 4,
            systemId: null,
            tools: { sevenZip: process.execPath },
          },
        },
        { signal: abort.signal },
      ),
      /cancel|abort/i,
    );
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      try {
        pid = Number(await readFile(f.path + '.child', 'utf8'));
      } catch {}
      if (!pid) await delay(20);
    }
    assert.ok(pid > 0, 'Native child started');
    abort.abort();
    await pending;
    await closeMatchingWorkers({ directory: f.directory });
    let active = true;
    for (let i = 0; i < 100 && active; i++) {
      try {
        process.kill(pid, 0);
        active = !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
          .trim()
          .startsWith('Z');
      } catch {
        active = false;
      }
      if (active) await delay(10);
    }
    assert.equal(active, false, 'Cancelled job must not leave a native reader running');
  } finally {
    await f.dispose();
  }
});
