import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { issueToken } from '@ecs/auth';
import { VirtualProviderRegistry } from '@ecs/storage';
import { openServer } from '../src/index.js';

test('CHD is opt-in and a configured missing decoder fails startup', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ecs-chd-server-'));
  try {
    const server = await openServer({ dataDir });
    const response = await server.app.inject('/api/v1/capabilities');
    assert.deepEqual(response.json().features.virtualFormats, ['zip']);
    await server.close();
    const configured = { dataDir, chdmanPath: join(dataDir, 'missing-decoder') };
    await assert.rejects(async () => {
      const unexpected = await openServer(configured);
      await unexpected.close();
    }, /CHD decoder configuration/);
    const reopened = await openServer({ dataDir });
    await reopened.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('configured CHD supports HTTP ranges and authorization and closes active native requests', async () => {
  const { PassThrough } = await import('node:stream');
  const { writeFile } = await import('node:fs/promises');
  const { issueToken } = await import('@ecs/auth');
  const dataDir = await mkdtemp(join(tmpdir(), 'ecs-chd-http-'));
  const executable = join(dataDir, 'decoder');
  await writeFile(executable, '', { mode: 0o700 });
  let decodes = 0;
  let probes = 0;
  let hang = false;
  let killed = false;
  let start: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
  const options = {
    runner: (_exe: string, args: readonly string[], config: { cwd: string }) => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      if (args[0] === 'help') {
        probes++;
        stdout.end('extractcd extractdvd -i -o -ob');
        stderr.end();
        return { stdout, stderr, exited: Promise.resolve({ code: 1 }), kill() {} };
      }
      decodes++;
      let finish: (value: { code: number | null }) => void = () => {};
      const exited = new Promise<{ code: number | null }>((resolve) => {
        finish = resolve;
      });
      const complete = (code: number | null) => {
        stdout.end();
        stderr.end();
        finish({ code });
      };
      if (hang) start();
      else void writeFile(join(config.cwd, 'disc.iso'), bytes).then(() => complete(0));
      return {
        stdout,
        stderr,
        exited,
        kill() {
          killed = true;
          complete(null);
        },
      };
    },
  };
  const server = await openServer({
    dataDir,
    chdmanPath: executable,
    chdProviderOptions: options,
    localTrust: false,
  });
  try {
    assert.equal(probes, 2);
    const capabilities = await server.app.inject('/api/v1/capabilities');
    assert.deepEqual(capabilities.json().features.virtualFormats, ['zip', 'chd']);
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const owner = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    const auth = { authorization: `Bearer ${owner.json().token}` };
    const libraries = await server.app.inject({ url: '/api/v1/libraries', headers: auth });
    const libraryId = libraries.json().items[0].id;
    const item = await server.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: auth,
      payload: { libraryId, systemIdentifier: 'com.provenance.psx', title: 'Generated disc' },
    });
    const source = Buffer.alloc(160);
    source.write('MComprHD');
    source.writeUInt32BE(124, 8);
    source.writeUInt32BE(5, 12);
    source.writeBigUInt64BE(4096n, 32);
    source.writeBigUInt64BE(124n, 40);
    source.writeBigUInt64BE(140n, 48);
    source.writeUInt32BE(4096, 56);
    source.writeUInt32BE(2048, 60);
    source.write('DVD ', 140);
    source.writeUIntBE(1, 145, 3);
    const upload = await server.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: auth,
      payload: { libraryId },
    });
    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${upload.json().id}/content`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: source,
    });
    const committed = await server.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${upload.json().id}/complete`,
      headers: auth,
      payload: {
        itemId: item.json().id,
        kind: 'rom',
        displayName: 'generated.chd',
        relativePath: 'generated.chd',
        baseRevision: item.json().revision,
      },
    });
    assert.equal(committed.statusCode, 201);
    const url = `/api/v1/files/${committed.json().id}/entries`;
    assert.equal((await server.app.inject(`${url}/0/content`)).statusCode, 401);
    assert.equal(decodes, 0);
    const listed = await server.app.inject({ url, headers: auth });
    assert.equal(listed.json().format, 'chd');
    assert.equal(decodes, 0);
    const ranged = await server.app.inject({
      url: `${url}/0/content`,
      headers: { ...auth, range: 'bytes=19-65' },
    });
    assert.equal(ranged.statusCode, 206);
    assert.deepEqual(ranged.rawPayload, bytes.subarray(19, 66));
    const full = await server.app.inject({ url: `${url}/0/content`, headers: auth });
    assert.deepEqual(full.rawPayload, bytes);
    assert.equal(full.headers.etag, ranged.headers.etag);
    const head = await server.app.inject({
      method: 'HEAD',
      url: `${url}/0/content`,
      headers: auth,
    });
    assert.equal(head.statusCode, 200);
    assert.equal(head.headers['content-length'], '4096');
    assert.equal(head.headers.etag, full.headers.etag);
    const suffix = await server.app.inject({
      url: `${url}/0/content`,
      headers: { ...auth, range: 'bytes=-17' },
    });
    assert.deepEqual(suffix.rawPayload, bytes.subarray(-17));
    assert.equal(
      (
        await server.app.inject({
          url: `${url}/0/content`,
          headers: { ...auth, range: 'bytes=4096-' },
        })
      ).statusCode,
      416,
    );
    assert.equal(decodes, 1);
    assert.equal(probes, 2);
    // Remove only this test's derived cache so the next HTTP request starts a job.
    await rm(join(dataDir, 'virtual-cache'), { recursive: true, force: true });
    hang = true;
    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const pending = fetch(`${address}${url}/0/content`, { headers: auth });
    void pending.then(() => {});
    await started;
    await Promise.race([
      server.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('shutdown did not cancel active request')), 2000),
      ),
    ]);
    assert.equal(killed, true);
    assert.equal((await pending).status, 422);
  } finally {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('configured incompatible executable fails startup instead of advertising CHD', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ecs-chd-incompatible-'));
  try {
    await assert.rejects(
      openServer({ dataDir, chdmanPath: process.execPath }),
      /CHD decoder configuration/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const survivor of [true, false]) {
  test(`HTTP disconnect ${survivor ? 'releases one waiter and preserves the survivor' : 'cancels and joins the last decoder before cleanup and reuse'}`, async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ecs-chd-disconnect-'));
    const executable = join(dataDir, 'decoder');
    await writeFile(executable, '', { mode: 0o700 });
    const bytes = Buffer.alloc(4096, 37);
    const jobs: Array<{
      finish(): Promise<void>;
      killed: ReturnType<typeof gate<void>>;
      join: ReturnType<typeof gate<void>>;
    }> = [];
    let started = gate();
    const server = await openServer({
      dataDir,
      chdmanPath: executable,
      localTrust: false,
      chdProviderOptions: {
        pollIntervalMs: 5,
        killGraceMs: 10,
        runner(_exe, args, options) {
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          if (args[0] === 'help') {
            stdout.end('extractcd extractdvd -i -o -ob');
            stderr.end();
            return { stdout, stderr, exited: Promise.resolve({ code: 1 }), kill() {} };
          }
          const exit = gate<{ code: number | null }>();
          const killed = gate();
          const joined = gate();
          jobs.push({
            killed,
            join: joined,
            async finish() {
              await rm(join(options.cwd, 'partial'));
              await writeFile(join(options.cwd, 'disc.iso'), bytes);
              stdout.end();
              stderr.end();
              exit.resolve({ code: 0 });
            },
          });
          // A side output proves cleanup must wait for child exit, not merely kill().
          void writeFile(join(options.cwd, 'partial'), 'in progress').then(() => started.resolve());
          return {
            stdout,
            stderr,
            exited: exit.promise,
            kill() {
              killed.resolve();
              void joined.promise.then(() => {
                stdout.end();
                stderr.end();
                exit.resolve({ code: null });
              });
            },
          };
        },
      },
    });
    const cancelled = gate();
    server.app.addHook('onError', async (_request, _reply, error) => {
      if (/cancelled/i.test(error.message)) cancelled.resolve();
    });
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const owner = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    const auth = { authorization: `Bearer ${owner.json().token}` };
    const libraries = await server.app.inject({ url: '/api/v1/libraries', headers: auth });
    const libraryId = libraries.json().items[0].id;
    const item = await server.app.inject({
      method: 'POST',
      url: '/api/v1/items',
      headers: auth,
      payload: {
        libraryId,
        systemIdentifier: 'com.provenance.psx',
        title: 'Generated disconnect disc',
      },
    });
    const source = Buffer.alloc(160);
    source.write('MComprHD');
    source.writeUInt32BE(124, 8);
    source.writeUInt32BE(5, 12);
    source.writeBigUInt64BE(4096n, 32);
    source.writeBigUInt64BE(124n, 40);
    source.writeBigUInt64BE(140n, 48);
    source.writeUInt32BE(4096, 56);
    source.writeUInt32BE(2048, 60);
    source.write('DVD ', 140);
    source.writeUIntBE(1, 145, 3);
    const upload = await server.app.inject({
      method: 'POST',
      url: '/api/v1/uploads',
      headers: auth,
      payload: { libraryId },
    });
    await server.app.inject({
      method: 'PUT',
      url: `/api/v1/uploads/${upload.json().id}/content`,
      headers: { ...auth, 'content-type': 'application/octet-stream' },
      payload: source,
    });
    const committed = await server.app.inject({
      method: 'POST',
      url: `/api/v1/uploads/${upload.json().id}/complete`,
      headers: auth,
      payload: {
        itemId: item.json().id,
        kind: 'rom',
        displayName: 'generated.chd',
        relativePath: 'generated.chd',
        baseRevision: item.json().revision,
      },
    });
    assert.equal(committed.statusCode, 201);
    const address = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `${address}/api/v1/files/${committed.json().id}/entries/0/content`;
    const resolved = gate();
    const original = VirtualProviderRegistry.prototype.resolve;
    let resolves = 0;
    t.mock.method(
      VirtualProviderRegistry.prototype,
      'resolve',
      async function (this: VirtualProviderRegistry, ...args: Parameters<typeof original>) {
        const result = await original.apply(this, args);
        if (++resolves === 2) resolved.resolve();
        return result;
      },
    );
    const first = get(url, { headers: auth });
    first.on('error', () => {});
    try {
      await within(started.promise, 'decoder did not start');
      const job = jobs[0];
      assert.ok(job);
      if (survivor) {
        const response = gate<{ status: number | undefined; bytes: Buffer }>();
        const second = get(url, { headers: { ...auth, range: 'bytes=19-65' } }, (reply) => {
          const chunks: Buffer[] = [];
          reply.on('data', (chunk) => chunks.push(chunk));
          reply.on('end', () =>
            response.resolve({ status: reply.statusCode, bytes: Buffer.concat(chunks) }),
          );
        });
        second.on('error', () => {});
        try {
          await within(resolved.promise, 'surviving waiter did not resolve');
          await nextTurn();
          first.destroy();
          await within(cancelled.promise, 'disconnected HTTP waiter was not cancelled');
          assert.equal(jobs.length, 1);
          await job.finish();
          const result = await within(response.promise, 'survivor did not finish');
          assert.equal(result.status, 206);
          assert.deepEqual(result.bytes, bytes.subarray(19, 66));
          assert.equal(jobs.length, 1);
        } finally {
          second.destroy();
        }
      } else {
        first.destroy();
        await within(job.killed.promise, 'last HTTP disconnect did not cancel decoder');
        const beforeExit = await readdir(join(dataDir, 'virtual-cache'), { recursive: true });
        assert.ok(beforeExit.some((name) => basename(name) === 'partial'));
        job.join.resolve();
        await within(cancelled.promise, 'cancelled HTTP route did not join decoder cleanup');
        const afterExit = await readdir(join(dataDir, 'virtual-cache'), { recursive: true });
        assert.equal(
          afterExit.some(
            (name) =>
              name.includes('.partial-') ||
              name.endsWith('.lock') ||
              name.endsWith('manifest.json'),
          ),
          false,
        );
        started = gate();
        const retry = fetch(url, { headers: auth });
        await within(started.promise, 'cancelled decoder did not release capacity');
        const next = jobs[1];
        assert.ok(next);
        await next.finish();
        const result = await retry;
        assert.equal(result.status, 200);
        assert.deepEqual(Buffer.from(await result.arrayBuffer()), bytes);
      }
    } finally {
      first.destroy();
      for (const job of jobs) job.join.resolve();
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}
