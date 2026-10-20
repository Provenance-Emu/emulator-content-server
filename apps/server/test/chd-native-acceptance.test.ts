import assert from 'node:assert/strict';
import childProcess, { type ChildProcess, execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { issueToken } from '@ecs/auth';
import { VirtualProviderRegistry } from '@ecs/storage';
import { openServer } from '../src/index.js';

const executable = process.env.ECS_CHDMAN_PATH;
const native = promisify(execFile);
const optIn =
  executable === undefined ? 'Set ECS_CHDMAN_PATH for real native HTTP acceptance' : false;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native acceptance condition timed out')), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function noisy(length: number, seed = 42) {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed & 255;
  }
  return bytes;
}
async function generated(root: string, cd: boolean) {
  assert.ok(executable);
  const source = join(root, cd ? 'source.cue' : 'source');
  const output = join(root, 'generated');
  if (!cd) {
    const bytes = noisy(2048 * 41);
    await writeFile(source, bytes);
    await native(executable, ['createdvd', '-i', source, '-o', output]);
    return { source: await readFile(output), outputs: [bytes] };
  }
  const modes = ['MODE1/2048', 'AUDIO', 'MODE1/2352', 'MODE2/2352'];
  const frames = [79, 83, 87, 91];
  const tracks = modes.map((mode, i) =>
    noisy((mode === 'MODE1/2048' ? 2048 : 2352) * (frames[i] ?? 0), 42 + i),
  );
  let cue = '';
  for (const [i, bytes] of tracks.entries()) {
    await writeFile(join(root, `track-${i}`), bytes);
    cue += `FILE "track-${i}" BINARY\n  TRACK ${String(i + 1).padStart(2, '0')} ${modes[i]}\n    INDEX 01 00:00:00\n`;
  }
  await writeFile(source, cue);
  await native(executable, ['createcd', '-i', source, '-o', output]);
  const canonical =
    'FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:01:04\n  TRACK 03 MODE1/2352\n    INDEX 01 00:02:12\n  TRACK 04 MODE2/2352\n    INDEX 01 00:03:24\n';
  return {
    source: await readFile(output),
    outputs: [Buffer.from(canonical), Buffer.concat(tracks)],
  };
}
async function upload(server: Awaited<ReturnType<typeof openServer>>, source: Buffer) {
  const bootstrap = issueToken();
  server.catalog.saveBootstrapHash(bootstrap.hash);
  const owner = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: {
      token: bootstrap.token,
      username: 'owner',
      password: 'correct-horse',
    },
  });
  assert.equal(owner.statusCode, 201);
  const headers = { authorization: `Bearer ${owner.json().token}` };
  const libraries = await server.app.inject({ url: '/api/v1/libraries', headers });
  const libraryId = libraries.json().items[0].id;
  const item = await server.app.inject({
    method: 'POST',
    url: '/api/v1/items',
    headers,
    payload: {
      libraryId,
      systemIdentifier: 'com.provenance.psx',
      title: 'Generated native acceptance',
    },
  });
  const pending = await server.app.inject({
    method: 'POST',
    url: '/api/v1/uploads',
    headers,
    payload: { libraryId },
  });
  const content = await server.app.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${pending.json().id}/content`,
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
    },
    payload: source,
  });
  assert.equal(content.statusCode, 204);
  const committed = await server.app.inject({
    method: 'POST',
    url: `/api/v1/uploads/${pending.json().id}/complete`,
    headers,
    payload: {
      itemId: item.json().id,
      kind: 'rom',
      displayName: 'generated.chd',
      relativePath: 'generated.chd',
      baseRevision: item.json().revision,
    },
  });
  assert.equal(committed.statusCode, 201);
  return { headers, path: `/api/v1/files/${committed.json().id}/entries` };
}
// Observe the actual ChildProcess returned to the production native runner.
// No decoder outputs, exit promises, streams or kill implementation are replaced.
function observeNative(
  t: TestContext,
  hooks: {
    start?: () => void;
    suspend?: boolean;
    closed?: (signal: string | null) => void;
    children: Set<ChildProcess>;
  },
  count: { decodes: number },
) {
  const original = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof original>) => {
    const child = original(...args);
    const command = args[1];
    if (Array.isArray(command) && ['extractcd', 'extractdvd'].includes(command[0] ?? '')) {
      count.decodes++;
      hooks.children.add(child);
      child.once('spawn', () => {
        if (hooks.suspend) {
          assert.equal(child.kill('SIGSTOP'), true);
          const deadline = Date.now() + 2000;
          let stopped = false;
          while (!stopped && Date.now() < deadline) {
            stopped = execFileSync('ps', ['-o', 'state=', '-p', String(child.pid)], {
              encoding: 'utf8',
            }).includes('T');
          }
          assert.equal(stopped, true, 'Native decoder did not enter the stopped OS state');
        }
        hooks.start?.();
      });
      child.once('close', (_code, signal) => hooks.closed?.(signal));
    }
    return child;
  });
  syncBuiltinESMExports();
}
function stopChildren(children: Set<ChildProcess>) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform !== 'win32') child.kill('SIGCONT');
      child.kill('SIGKILL');
    }
  }
}
function guardCleanup(
  t: TestContext,
  root: string,
  children: Set<ChildProcess>,
  resources: () => {
    server: Awaited<ReturnType<typeof openServer>> | undefined;
    request?: ReturnType<typeof get>;
  },
) {
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      resources().request?.destroy();
      stopChildren(children);
      await resources().server?.close();
    } finally {
      try {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
  t.after(cleanup);
  return cleanup;
}
async function cacheSnapshot(dataDir: string) {
  const root = join(dataDir, 'virtual-cache');
  const files = (await readdir(root, { recursive: true })).sort();
  const result = [];
  for (const path of files) {
    const info = await stat(join(root, path));
    if (info.isFile()) result.push([path, info.size, info.mtimeMs]);
  }
  return result;
}

for (const cd of [false, true]) {
  test(`real native ${cd ? 'mixed CD' : 'DVD'} HTTP bytes, ranges, HEAD, grouped concurrency and restart reuse`, {
    skip: optIn,
  }, async (t) => {
    assert.ok(executable);
    const root = await mkdtemp(join(tmpdir(), 'ecs-native-http-'));
    const children = new Set<ChildProcess>();
    let server: Awaited<ReturnType<typeof openServer>> | undefined;
    const cleanup = guardCleanup(t, root, children, () => ({ server }));
    const dataDir = join(root, 'data');
    const fixture = await generated(root, cd);
    t.diagnostic(
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        sha256: fixture.outputs.map(hash),
      }),
    );
    const count = { decodes: 0 };
    const started = gate();
    const hooks = { start: started.resolve, suspend: process.platform !== 'win32', children };
    observeNative(t, hooks, count);
    const joined = gate();
    server = await openServer({
      dataDir,
      chdmanPath: executable,
      localTrust: false,
    });
    try {
      const { headers, path } = await upload(server, fixture.source);
      const address = await server.app.listen({
        host: '127.0.0.1',
        port: Number(process.env.ECS_CHD_NATIVE_PORT ?? 0),
      });
      assert.equal((await fetch(`${address}${path}/0/content`)).status, 401);
      const listed = await fetch(`${address}${path}`, { headers });
      assert.equal(listed.status, 200);
      assert.equal(((await listed.json()) as { format: string }).format, 'chd');
      assert.equal(count.decodes, 0);
      const original = VirtualProviderRegistry.prototype.resolve;
      let resolves = 0;
      t.mock.method(
        VirtualProviderRegistry.prototype,
        'resolve',
        async function (this: VirtualProviderRegistry, ...args: Parameters<typeof original>) {
          const result = await original.apply(this, args);
          if (++resolves === 2) joined.resolve();
          return result;
        },
      );
      const first = fetch(`${address}${path}/0/content`, { headers, method: 'HEAD' });
      await within(started.promise);
      const secondId = cd ? 1 : 0;
      const second = fetch(`${address}${path}/${secondId}/content`, { headers });
      await within(joined.promise);
      if (process.platform !== 'win32') {
        for (const child of children) child.kill('SIGCONT');
      }
      hooks.suspend = false;
      const [head, full] = await Promise.all([first, second]);
      assert.equal(head.status, 200);
      assert.equal(head.headers.get('content-length'), String(fixture.outputs[0]?.length));
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      assert.equal(full.status, 200);
      assert.equal(
        hash(Buffer.from(await full.arrayBuffer())),
        hash(fixture.outputs[secondId] ?? Buffer.alloc(0)),
      );
      assert.equal(count.decodes, 1);
      const etags: Array<string | null> = [];
      for (const [id, expected] of fixture.outputs.entries()) {
        const url = `${address}${path}/${id}/content`;
        const whole = await fetch(url, { headers });
        assert.equal(hash(Buffer.from(await whole.arrayBuffer())), hash(expected));
        const etag = whole.headers.get('etag');
        assert.ok(etag);
        etags.push(etag);
        for (const [range, bytes, contentRange] of [
          ['bytes=19-65', expected.subarray(19, 66), `bytes 19-65/${expected.length}`],
          [
            'bytes=-17',
            expected.subarray(-17),
            `bytes ${expected.length - 17}-${expected.length - 1}/${expected.length}`,
          ],
        ] as const) {
          const reply = await fetch(url, { headers: { ...headers, range } });
          assert.equal(reply.status, 206);
          assert.equal(reply.headers.get('content-range'), contentRange);
          assert.equal(reply.headers.get('etag'), etag);
          assert.deepEqual(Buffer.from(await reply.arrayBuffer()), bytes);
        }
        const invalid = await fetch(url, {
          headers: { ...headers, range: `bytes=${expected.length}-` },
        });
        assert.equal(invalid.status, 416);
        await invalid.arrayBuffer();
      }
      const snapshot = await cacheSnapshot(dataDir);
      assert.equal(head.headers.get('etag'), etags[0]);
      assert.equal(snapshot.filter(([path]) => String(path).endsWith('manifest.json')).length, 1);
      await server.close();
      server = await openServer({
        dataDir,
        chdmanPath: executable,
        localTrust: false,
      });
      const reopened = await server.app.listen({
        host: '127.0.0.1',
        port: Number(process.env.ECS_CHD_NATIVE_PORT ?? 0),
      });
      for (const [id, expected] of fixture.outputs.entries()) {
        const reply = await fetch(`${reopened}${path}/${id}/content`, { headers });
        assert.equal(reply.status, 200);
        assert.equal(reply.headers.get('etag'), etags[id]);
        assert.equal(hash(Buffer.from(await reply.arrayBuffer())), hash(expected));
      }
      assert.equal(count.decodes, 1);
      assert.deepEqual(await cacheSnapshot(dataDir), snapshot);
    } finally {
      await cleanup();
    }
  });
}

for (const shutdown of [false, true]) {
  test(`real native suspended decoder ${shutdown ? 'shutdown' : 'last HTTP disconnect'} joins child and cleans staging`, {
    skip:
      optIn ||
      (process.platform === 'win32'
        ? 'Deterministic real-process suspension requires POSIX signals'
        : false),
  }, async (t) => {
    assert.ok(executable);
    const root = await mkdtemp(join(tmpdir(), 'ecs-native-cancel-'));
    const children = new Set<ChildProcess>();
    let server: Awaited<ReturnType<typeof openServer>> | undefined;
    let request: ReturnType<typeof get> | undefined;
    const cleanup = guardCleanup(t, root, children, () => ({ server, request }));
    const dataDir = join(root, 'data');
    const fixture = await generated(root, false);
    const count = { decodes: 0 };
    const started = gate();
    const cancelled = gate();
    const childClosed = gate<string | null>();
    const hooks = { suspend: true, start: started.resolve, closed: childClosed.resolve, children };
    observeNative(t, hooks, count);
    server = await openServer({
      dataDir,
      chdmanPath: executable,
      localTrust: false,
      chdProviderOptions: { pollIntervalMs: 5, killGraceMs: 10 },
    });
    server.app.addHook('onError', async (_request, _reply, error) => {
      if (/cancelled/i.test(error.message)) cancelled.resolve();
    });
    try {
      const { headers, path } = await upload(server, fixture.source);
      const address = await server.app.listen({
        host: '127.0.0.1',
        port: Number(process.env.ECS_CHD_NATIVE_PORT ?? 0),
      });
      request = get(`${address}${path}/0/content`, { headers }, (reply) => reply.resume());
      request.on('error', () => {});
      await within(started.promise);
      assert.ok(
        (await readdir(join(dataDir, 'virtual-cache'), { recursive: true })).some((path) =>
          path.includes('.partial-'),
        ),
      );
      if (shutdown) await within(server.close());
      else request.destroy();
      assert.ok(['SIGTERM', 'SIGKILL'].includes((await within(childClosed.promise)) ?? ''));
      for (const child of children) {
        assert.throws(() => process.kill(child.pid ?? 0, 0), { code: 'ESRCH' });
      }
      await within(cancelled.promise);
      const files = await readdir(join(dataDir, 'virtual-cache'), { recursive: true });
      assert.equal(
        files.some(
          (path) =>
            path.includes('.partial-') || path.endsWith('.lock') || path.endsWith('manifest.json'),
        ),
        false,
      );
      if (!shutdown) {
        hooks.suspend = false;
        const reply = await fetch(`${address}${path}/0/content`, { headers });
        assert.equal(reply.status, 200);
        assert.equal(
          hash(Buffer.from(await reply.arrayBuffer())),
          hash(fixture.outputs[0] ?? Buffer.alloc(0)),
        );
        assert.equal(count.decodes, 2);
      }
    } finally {
      await cleanup();
    }
  });
}
