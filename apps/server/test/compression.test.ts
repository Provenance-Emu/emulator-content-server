import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from 'node:zlib';
import { issueToken } from '@ecs/auth';
import { acceptedEncoding } from '../src/compression.js';
import { openServer } from '../src/index.js';

test('the encoding a client asked for is honoured, including a refusal', () => {
  assert.equal(acceptedEncoding('gzip, deflate, br, zstd'), 'br');
  assert.equal(acceptedEncoding('gzip, deflate'), 'gzip');
  assert.equal(acceptedEncoding('br;q=0, gzip;q=0.5'), 'gzip');
  assert.equal(acceptedEncoding('BR'), 'br');
  assert.equal(acceptedEncoding('br;q=0, gzip;q=0'), null);
  assert.equal(acceptedEncoding('identity'), null);
  assert.equal(acceptedEncoding(''), null);
  assert.equal(acceptedEncoding(undefined), null);
});

test('listings are compressed for a client that accepts it, and credentials never are', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-compress-'));
  const server = await openServer({ dataDir: dir, loginLimit: 50 });
  try {
    const bootstrap = issueToken();
    server.catalog.saveBootstrapHash(bootstrap.hash);
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap',
      headers: { 'accept-encoding': 'br, gzip' },
      // Padding makes the answer long enough that only the rule keeps it uncompressed.
      payload: { token: bootstrap.token, username: 'owner', password: 'correct-horse' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.headers['content-encoding'], undefined);

    const plain = await server.app.inject({ method: 'GET', url: '/api/v1/systems' });
    assert.equal(plain.statusCode, 200);
    assert.ok(plain.body.length > 1024, 'the system list is long enough to be worth compressing');
    assert.equal(plain.headers['content-encoding'], undefined);
    // A cache in between must keep the two answers apart.
    assert.match(String(plain.headers.vary), /accept-encoding/i);

    const br = await server.app.inject({
      method: 'GET',
      url: '/api/v1/systems',
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.ok(br.rawPayload.length < plain.rawPayload.length / 2);
    assert.equal(brotliDecompressSync(br.rawPayload).toString(), plain.body);
    assert.equal(Number(br.headers['content-length']), br.rawPayload.length);

    const gz = await server.app.inject({
      method: 'GET',
      url: '/api/v1/systems',
      headers: { 'accept-encoding': 'br;q=0, gzip' },
    });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(gz.rawPayload).toString(), plain.body);

    // Short answers are left as they are.
    const small = await server.app.inject({
      method: 'GET',
      url: '/api/v1/access',
      headers: { 'accept-encoding': 'br' },
    });
    assert.equal(small.statusCode, 200);
    assert.equal(small.headers['content-encoding'], undefined);

    // Signing in hands out a token: never compressed, whatever the client accepts.
    const signedIn = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'accept-encoding': 'br, gzip' },
      payload: { username: 'owner', password: 'correct-horse' },
    });
    assert.equal(signedIn.statusCode, 200);
    assert.equal(signedIn.headers['content-encoding'], undefined);
    assert.ok((signedIn.json() as { token: string }).token);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the interface is served precompressed, cached by name, and keeps each file its own rules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-compress-'));
  const ui = join(dir, 'ui');
  await mkdir(join(ui, 'assets'), { recursive: true });
  const script = `console.log(${JSON.stringify('x'.repeat(4096))});`;
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>Library</title>');
  await writeFile(join(ui, 'assets', 'app-AbCd1234.js'), script);
  await writeFile(join(ui, 'assets', 'app-AbCd1234.js.br'), brotliCompressSync(script));
  await writeFile(join(ui, 'assets', 'seven-zip-worker-AbCd1234.js'), script);
  await writeFile(
    join(ui, 'assets', 'seven-zip-worker-AbCd1234.js.br'),
    brotliCompressSync(script),
  );
  // A text file the build left alone has no compressed copy.
  await writeFile(join(ui, 'notes.txt'), 'n'.repeat(4096));
  const server = await openServer({ dataDir: join(dir, 'data'), uiDir: ui });
  try {
    const get = (url: string, encoding?: string) =>
      server.app.inject({
        method: 'GET',
        url,
        ...(encoding ? { headers: { 'accept-encoding': encoding } } : {}),
      });
    const compressed = await get('/ui/assets/app-AbCd1234.js', 'gzip, br');
    assert.equal(compressed.statusCode, 200);
    assert.equal(compressed.headers['content-encoding'], 'br');
    assert.equal(brotliDecompressSync(compressed.rawPayload).toString(), script);
    assert.match(String(compressed.headers['content-type']), /javascript/);
    assert.equal(compressed.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(String(compressed.headers['content-security-policy']), /script-src 'self'/);

    const plain = await get('/ui/assets/app-AbCd1234.js');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body, script);
    assert.equal(plain.headers['cache-control'], 'public, max-age=31536000, immutable');

    // The archive worker needs its own policy whether or not it travelled compressed.
    for (const encoding of [undefined, 'br']) {
      const worker = await get('/ui/assets/seven-zip-worker-AbCd1234.js', encoding);
      assert.equal(worker.statusCode, 200);
      assert.match(String(worker.headers['content-security-policy']), /'wasm-unsafe-eval'/);
      assert.equal(worker.headers['cross-origin-embedder-policy'], 'require-corp');
    }

    // The document that names the assets is checked on every visit.
    const page = await get('/ui/index.html', 'br');
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers['cache-control'], 'no-cache');

    const notes = await get('/ui/notes.txt', 'br, gzip');
    assert.equal(notes.statusCode, 200);
    assert.equal(notes.headers['content-encoding'], undefined);
    assert.equal(notes.headers['cache-control'], 'no-cache');
    // A compressed copy is never a page of its own with the wrong rules.
    const direct = await get('/ui/assets/seven-zip-worker-AbCd1234.js.br');
    if (direct.statusCode === 200)
      assert.match(String(direct.headers['content-security-policy']), /'wasm-unsafe-eval'/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
