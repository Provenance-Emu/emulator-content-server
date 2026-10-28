import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { issueToken } from '@ecs/auth';
import { openServer } from '../src/index.js';

function bundle(id = 'org.example.player', systems = ['com.provenance.nes']) {
  const loader = Buffer.from('export default async()=>({FS:{},callMain(){}});'),
    wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const manifest = {
    id,
    name: 'Fixture player',
    kind: 'player',
    version: '1',
    engine: 'ecs.plugin/1',
    apps: ['org.example.test'],
    player: {
      systems,
      module: 'core.wasm',
      web: {
        profileVersion: 1,
        runtime: 'emscripten-esm-v1',
        filesystem: 'memfs',
        threaded: false,
        saveCompletion: 'none',
        contentExtensions: ['nes'],
        maxContentBytes: 1024,
        buildVersion: 'generated',
        loader: { file: 'loader.js', sha256: hash(loader) },
        wasm: { file: 'core.wasm', sha256: hash(wasm) },
        assets: [],
      },
    },
  };
  const header = Buffer.from(
      JSON.stringify({
        manifest,
        files: [
          { name: 'loader.js', size: loader.length },
          { name: 'core.wasm', size: wasm.length },
        ],
      }),
    ),
    prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  return { manifest, loader, wasm, bytes: Buffer.concat([prefix, header, loader, wasm]) };
}
async function fixture(t: import('node:test').TestContext, operator = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-player-manager-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataDir = join(directory, 'data'),
    registry = join(directory, 'operators');
  if (operator) {
    const p = join(registry, 'fixture'),
      b = bundle();
    await mkdir(p, { recursive: true });
    await writeFile(join(p, 'plugin.json'), JSON.stringify(b.manifest));
    await writeFile(join(p, 'loader.js'), b.loader);
    await writeFile(join(p, 'core.wasm'), b.wasm);
  }
  const server = await openServer({
    dataDir,
    localTrust: true,
    ...(operator ? { playerPluginsDir: registry } : {}),
  });
  t.after(() => server.close());
  const token = issueToken();
  server.catalog.saveBootstrapHash(token.hash);
  const session = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/bootstrap',
    payload: { token: token.token, username: 'owner', password: 'generated-password' },
  });
  assert.equal(session.statusCode, 201);
  return { server, dataDir, headers: { authorization: `Bearer ${session.json().token}` } };
}
test('owner package install is atomic, immediately playable, persistent and removable without game data changes', async (t) => {
  const f = await fixture(t),
    url = '/api/v1/player/management';
  assert.equal(
    (await f.server.app.inject({ url })).statusCode,
    403,
    'local-trust does not grant software management',
  );
  const before = f.server.catalog.listLibraries('fixture', true).length;
  const installed = await f.server.app.inject({
    method: 'POST',
    url: url + '/install',
    headers: { ...f.headers, 'content-type': 'application/vnd.ecs.player-package' },
    payload: bundle().bytes,
  });
  assert.equal(installed.statusCode, 200, installed.body);
  assert.equal(installed.json().items[0].source, 'managed');
  assert.equal(
    (await f.server.app.inject({ url: '/play/plugins/org.example.player/core.wasm' })).statusCode,
    200,
  );
  const duplicate = await f.server.app.inject({
    method: 'POST',
    url: url + '/install',
    headers: { ...f.headers, 'content-type': 'application/vnd.ecs.player-package' },
    payload: bundle().bytes,
  });
  assert.equal(duplicate.statusCode, 409);
  const disabled = await f.server.app.inject({
    method: 'PATCH',
    url: url + '/org.example.player',
    headers: f.headers,
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(
    (await f.server.app.inject({ url: '/api/v1/player/profiles' })).json().items.length,
    0,
  );
  assert.equal(
    (await f.server.app.inject({ url: '/play/plugins/org.example.player/core.wasm' })).statusCode,
    404,
  );
  await f.server.close();
  const reopened = await openServer({ dataDir: f.dataDir });
  t.after(() => reopened.close());
  assert.equal(
    (await reopened.app.inject({ url, headers: f.headers })).json().items[0].enabled,
    false,
  );
  const enabled = await reopened.app.inject({
    method: 'PATCH',
    url: url + '/org.example.player',
    headers: f.headers,
    payload: { enabled: true, default: true },
  });
  assert.equal(enabled.json().defaultProfileId, 'org.example.player');
  const removed = await reopened.app.inject({
    method: 'DELETE',
    url: url + '/org.example.player',
    headers: f.headers,
  });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().items.length, 0);
  assert.equal(reopened.catalog.listLibraries('fixture', true).length, before);
  await assert.rejects(
    readFile(join(f.dataDir, 'players/org.example.player/plugin.json')),
    /ENOENT/,
  );
});
test('malformed or unverified packages and unauthorized requests never activate code', async (t) => {
  const f = await fixture(t);
  const url = '/api/v1/player/management/install',
    headers = { ...f.headers, 'content-type': 'application/vnd.ecs.player-package' };
  for (const payload of [
    Buffer.alloc(2),
    Buffer.from([255, 255, 255, 255]),
    Buffer.concat([bundle().bytes, Buffer.from([1])]),
    Buffer.from(bundle().bytes.map((b, i, a) => (i === a.length - 1 ? 9 : b))),
  ]) {
    const response = await f.server.app.inject({ method: 'POST', url, headers, payload });
    assert.equal(response.statusCode, 400, response.body);
  }
  const denied = await f.server.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/vnd.ecs.player-package' },
    payload: bundle().bytes,
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(
    (await f.server.app.inject({ url: '/api/v1/player/profiles' })).json().items.length,
    0,
  );
  const unknown = await f.server.app.inject({
    method: 'POST',
    url: url + '/https%3A%2F%2Flocalhost',
    headers: f.headers,
    payload: { url: 'http://127.0.0.1' },
  });
  assert.equal(unknown.statusCode, 404);
});
test('operator profiles can be disabled but not deleted and serialized duplicate installs preserve one version', async (t) => {
  const f = await fixture(t, true),
    url = '/api/v1/player/management';
  assert.equal(
    (
      await f.server.app.inject({
        method: 'DELETE',
        url: url + '/org.example.player',
        headers: f.headers,
      })
    ).statusCode,
    403,
  );
  const body = bundle('org.example.other').bytes;
  const results = await Promise.all(
    [1, 2].map(() =>
      f.server.app.inject({
        method: 'POST',
        url: url + '/install',
        headers: { ...f.headers, 'content-type': 'application/vnd.ecs.player-package' },
        payload: body,
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal((await f.server.app.inject({ url, headers: f.headers })).json().items.length, 2);
});
test('managed registry symlinks are refused at startup', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-player-manager-link-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'data'));
  await mkdir(join(dir, 'outside'));
  await symlink(join(dir, 'outside'), join(dir, 'data/players'), 'dir');
  await assert.rejects(openServer({ dataDir: join(dir, 'data') }), /player directory/i);
});

test('large buffered player packages are parsed only inside the authenticated management router', async (t) => {
  const f = await fixture(t);
  const response = await f.server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'content-type': 'application/vnd.ecs.player-package' },
    payload: Buffer.alloc(2 * 1024 * 1024),
  });
  assert.equal(
    response.statusCode,
    415,
    'Public login must not recognize the large private package parser',
  );
});

test('Atomiswave is offered only after owner-supplied system-file installation, without changing core bytes', async (t) => {
  const f = await fixture(t),
    id = 'org.libretro.parallel-dc',
    headers = { ...f.headers, 'content-type': 'application/vnd.ecs.player-package' };
  const response = await f.server.app.inject({
    method: 'POST',
    url: '/api/v1/player/management/install',
    headers,
    payload: bundle(id, ['com.provenance.dreamcast', 'com.provenance.atomiswave']).bytes,
  });
  assert.equal(response.statusCode, 200, response.body);
  const catalog = () => f.server.app.inject({ url: '/api/v1/player/profiles' });
  assert.deepEqual((await catalog()).json().items[0].systems, ['com.provenance.dreamcast']);
  const url = `/api/v1/player/management/${id}/system/awbios.zip`,
    firmwareHeaders = { ...f.headers, 'content-type': 'application/vnd.ecs.player-system-file' };
  assert.equal(
    (
      await f.server.app.inject({
        method: 'PUT',
        url,
        headers: firmwareHeaders,
        payload: Buffer.alloc(22),
      })
    ).statusCode,
    400,
  );
  // Generated all-zero ZIP data tests file management, never a real boot ROM or firmware acceptance.
  const name = Buffer.from('bios0.ic23'),
    data = Buffer.alloc(131072),
    local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  const zip = Buffer.concat([local, name, data, central, name, end]);
  const installed = await f.server.app.inject({
    method: 'PUT',
    url,
    headers: firmwareHeaders,
    payload: zip,
  });
  assert.equal(installed.statusCode, 200, installed.body);
  assert.deepEqual((await catalog()).json().items[0].systems, [
    'com.provenance.dreamcast',
    'com.provenance.atomiswave',
  ]);
  const served = await f.server.app.inject({ url: `/play/plugins/${id}/assets/awbios.zip` });
  assert.deepEqual(served.rawPayload, zip);
  assert.equal(
    (await f.server.app.inject({ url: `/play/plugins/${id}/core.wasm` })).rawPayload.length,
    8,
  );
});
