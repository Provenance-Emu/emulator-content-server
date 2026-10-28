import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

const loader = 'export default async () => ({ FS: {} });\n';
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function descriptor() {
  return {
    version: 1,
    id: 'fceumm',
    name: 'FCEUmm',
    systems: ['com.provenance.nes'],
    runtime: 'retroarch-emscripten-esm',
    threaded: false,
    filesystem: 'memfs',
    saveCompletion: 'command-reply-v1',
    frontendCommit: '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66',
    coreCommit: 'ac0d00a7fc01166f84c7bac01d1084ebfd2b865e',
    emscriptenVersion: '3.1.46',
    contentExtension: 'nes',
    maxContentBytes: 64 * 1024 * 1024,
    loader: { file: 'fceumm_libretro.js', sha256: sha(loader) },
    wasm: { file: 'fceumm_libretro.wasm', sha256: sha(wasm) },
  };
}
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-player-'));
  let closeServer: (() => Promise<void>) | undefined;
  t.after(async () => {
    await closeServer?.();
    await rm(dir, { recursive: true, force: true });
  });
  const playerDir = join(dir, 'player');
  await mkdir(playerDir);
  await writeFile(join(playerDir, 'core.json'), JSON.stringify(descriptor()));
  await writeFile(join(playerDir, 'fceumm_libretro.js'), loader);
  await writeFile(join(playerDir, 'fceumm_libretro.wasm'), wasm);
  return {
    dir,
    playerDir,
    closeBeforeRemove(close: () => Promise<void>) {
      closeServer = close;
    },
  };
}
async function setup(t: TestContext, localTrust = false, withUi = false) {
  const f = await fixture(t);
  const uiDir = withUi ? join(f.dir, 'ui') : null;
  if (uiDir) {
    await mkdir(uiDir);
    await writeFile(join(uiDir, 'index.html'), '<!doctype html><title>UI</title>');
  }
  const server = await openServer({
    dataDir: join(f.dir, 'data'),
    localTrust,
    uiDir,
    playerDir: f.playerDir,
  });
  f.closeBeforeRemove(() => server.close());
  const token = issueToken();
  server.catalog.saveBootstrapHash(token.hash);
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: {
      token: token.token,
      username: 'owner',
      password: 'correct-horse',
    },
  });
  assert.equal(response.statusCode, 201);
  const owner = { authorization: `Bearer ${response.json().token}` };
  return { ...f, ...server, owner };
}
const paths = [
  '/api/v1/player/core',
  '/play/cores/fceumm/loader.js',
  '/play/cores/fceumm/core.wasm',
];

test('playback is disabled by default without affecting the public API', async (t) => {
  const f = await fixture(t);
  const server = await openServer({ dataDir: join(f.dir, 'data') });
  f.closeBeforeRemove(() => server.close());
  const capabilities = await server.app.inject({ url: '/api/v1/capabilities' });
  assert.equal(capabilities.json().features.webPlayback, false);
  for (const url of paths) assert.equal((await server.app.inject({ url })).statusCode, 404);
});

test('configured core exposes only immutable verified buffers and a path-free descriptor', async (t) => {
  const { app, playerDir, owner } = await setup(t);
  assert.equal(
    (await app.inject({ url: '/api/v1/capabilities' })).json().features.webPlayback,
    true,
  );
  const metadata = await app.inject({ url: paths[0], headers: owner });
  assert.equal(metadata.statusCode, 200);
  assert.deepEqual(metadata.json().loader, {
    url: paths[1],
    sha256: sha(loader),
    sizeBytes: Buffer.byteLength(loader),
  });
  assert.equal(metadata.body.includes(playerDir), false);
  assert.equal(metadata.body.includes('"file"'), false);
  await writeFile(join(playerDir, 'fceumm_libretro.js'), 'changed on disk');
  await rm(join(playerDir, 'fceumm_libretro.wasm'));
  for (const [url, body, mime] of [
    [paths[1], Buffer.from(loader), 'text/javascript'],
    [paths[2], wasm, 'application/wasm'],
  ] as const) {
    const response = await app.inject({ url, headers: owner });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.rawPayload, body);
    assert.match(response.headers['content-type'] as string, new RegExp(mime));
    assert.equal(response.headers.etag, `"${sha(body)}"`);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
  }
});

test('legacy core also exposes the portable profile contract as the default', async (t) => {
  const { app, owner } = await setup(t);
  const catalog = (await app.inject({ url: '/api/v1/player/profiles', headers: owner })).json();
  assert.equal(catalog.defaultProfileId, 'fceumm');
  assert.equal(catalog.items[0].runtime, 'retroarch-emscripten-esm');
  assert.deepEqual(catalog.items[0].contentExtensions, ['nes']);
  assert.deepEqual(catalog.items[0].assets, []);
  assert.equal(catalog.items[0].loader.url, '/play/plugins/fceumm/loader.js');
  assert.match(catalog.items[0].buildVersion, /3\.1\.46/);
  assert.equal(
    (await app.inject({ url: '/play/plugins/fceumm/loader.js', headers: owner })).body,
    loader,
  );
});

test('core metadata and bytes require read permission and never query credentials', async (t) => {
  const { app, owner } = await setup(t);
  const device = await app.inject({
    method: 'POST',
    url: '/api/v1/device-tokens',
    headers: owner,
    payload: { name: 'writer', scopes: ['write'] },
  });
  assert.equal(device.statusCode, 201);
  const libraries = await app.inject({ url: '/api/v1/libraries', headers: owner });
  const guest = await app.inject({
    method: 'POST',
    url: '/api/v1/guest-grants',
    headers: owner,
    payload: {
      libraryId: libraries.json().items[0].id,
      capabilities: ['read'],
      expiresInSeconds: 3600,
    },
  });
  assert.equal(guest.statusCode, 201);
  for (const url of [
    ...paths,
    '/api/v1/player/profiles',
    '/api/v1/player/profiles/fceumm',
    '/play/plugins/fceumm/loader.js',
    '/play/plugins/fceumm/core.wasm',
  ]) {
    assert.equal(
      (await app.inject({ url, headers: { 'x-forwarded-for': '127.0.0.1' } })).statusCode,
      401,
    );
    assert.equal((await app.inject({ url: `${url}?token=${guest.json().token}` })).statusCode, 401);
    assert.equal(
      (await app.inject({ url, headers: { authorization: `Bearer ${device.json().token}` } }))
        .statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url, headers: { authorization: `Bearer ${guest.json().token}` } }))
        .statusCode,
      200,
    );
  }
});

test('local LAN trust and token mode apply to core resources', async (t) => {
  const { app, owner } = await setup(t, true);
  for (const url of paths)
    assert.equal((await app.inject({ url, remoteAddress: '192.168.1.20' })).statusCode, 200);
  const changed = await app.inject({
    method: 'PUT',
    url: '/api/v1/access',
    headers: owner,
    payload: { mode: 'token', subnets: [] },
  });
  assert.equal(changed.statusCode, 200);
  for (const url of paths) assert.equal((await app.inject({ url })).statusCode, 401);
});

test('core routes never serve arbitrary files or IDs', async (t) => {
  const { app, playerDir, owner } = await setup(t);
  await writeFile(join(playerDir, 'secrets.json'), 'fixture-secret');
  for (const url of [
    '/play/cores/fceumm/secrets.json',
    '/play/cores/other/loader.js',
    '/play/cores/fceumm/%2e%2e%2fsecrets.json',
    '/play/cores/%2e%2e/loader.js',
  ]) {
    const response = await app.inject({ url, headers: owner });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.includes('fixture-secret'), false);
  }
});

for (const [name, patch] of [
  ['unsupported profile', { saveCompletion: 'memfs-observer' }],
  ['wrong pin', { coreCommit: '0'.repeat(40) }],
  ['unsafe ID', { id: '../escape' }],
  ['invalid size', { maxContentBytes: 67108865 }],
  ['traversal', { loader: { file: '../secrets.json', sha256: sha(loader) } }],
  ['digest mismatch', { loader: { file: 'fceumm_libretro.js', sha256: '0'.repeat(64) } }],
  ['placeholder digest', { wasm: { file: 'fceumm_libretro.wasm', sha256: 'TODO' } }],
] as const) {
  test(`configured ${name} fails startup`, async (t) => {
    const { dir, playerDir } = await fixture(t);
    await writeFile(join(playerDir, 'core.json'), JSON.stringify({ ...descriptor(), ...patch }));
    await assert.rejects(
      openServer(Object.assign({ dataDir: join(dir, 'data') }, { playerDir })),
      /player|core/i,
    );
  });
}
for (const mode of ['missing', 'symlink', 'oversized', 'directory', 'extra-secret'] as const) {
  test(`configured ${mode} core file fails startup`, async (t) => {
    const { dir, playerDir } = await fixture(t);
    const file = join(playerDir, 'fceumm_libretro.js');
    if (mode === 'oversized') await truncate(file, 8 * 1024 * 1024 + 1);
    else if (mode === 'extra-secret') await writeFile(join(playerDir, 'secrets.json'), '{}');
    else {
      await rm(file);
      if (mode === 'directory') await mkdir(file);
      if (mode === 'symlink') {
        await writeFile(join(dir, 'external.js'), loader);
        await symlink(join(dir, 'external.js'), file);
      }
    }
    await assert.rejects(
      openServer(Object.assign({ dataDir: join(dir, 'data') }, { playerDir })),
      /player|core/i,
    );
  });
}

test('configuring playback preserves the exact existing UI browser policy', async (t) => {
  const { app } = await setup(t, false, true);
  const response = await app.inject({ url: '/ui/' });
  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers['content-security-policy'],
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.equal(response.headers['cross-origin-opener-policy'], undefined);
  assert.equal(response.headers['cross-origin-embedder-policy'], undefined);
});
