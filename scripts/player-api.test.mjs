/** Generated runtime, real ContentClient + HTTP authorization/upload/keep-both/catalog. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openServer } from '../apps/server/dist/src/index.js';
import { startPlayer } from '../apps/web/dist-tests/src/player/controller.js';
import { fixture } from '../apps/web/dist-tests/test/player-fixture.js';
import { ContentClient, ContentError } from '../packages/client-ts/dist/src/index.js';

/** @param {string | Uint8Array} bytes */
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** @param {import('node:test').TestContext} t */
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-browser-api-'));
  /** @type {Awaited<ReturnType<typeof openServer>> | undefined} */
  let server;
  t.after(async () => {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  });
  const playerDir = join(dir, 'player');
  await mkdir(playerDir);
  const loader = 'export default ()=>({});';
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const f = fixture();
  await writeFile(join(playerDir, 'fceumm_libretro.js'), loader);
  await writeFile(join(playerDir, 'fceumm_libretro.wasm'), wasm);
  await writeFile(
    join(playerDir, 'core.json'),
    JSON.stringify({
      ...f.core,
      loader: { file: 'fceumm_libretro.js', sha256: sha(loader) },
      wasm: { file: 'fceumm_libretro.wasm', sha256: sha(wasm) },
    }),
  );
  server = await openServer({ dataDir: join(dir, 'data'), playerDir, localTrust: false });
  const origin = await server.app.listen({ host: '127.0.0.1', port: 0 });
  const bootstrap = randomBytes(32).toString('base64url');
  server.catalog.saveBootstrapHash(sha(bootstrap));
  const owner = new ContentClient(origin);
  const session = await owner.bootstrap(bootstrap, 'owner', 'correct-horse');
  owner.setToken(session.token);
  const opened = server;
  /** @param {string} name @param {string[]} scopes */
  async function device(name, scopes) {
    const response = await opened.app.inject({
      method: 'POST',
      url: '/api/v1/device-tokens',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { name, scopes },
    });
    assert.equal(response.statusCode, 201);
    return new ContentClient(origin, response.json().token);
  }
  const browser = await device('browser', ['read', 'write']);
  const phone = await device('phone', ['read', 'write']);
  const library = (await owner.libraries()).items[0];
  assert.ok(library);
  const item = await owner.createItem({
    libraryId: library.id,
    systemIdentifier: 'com.provenance.nes',
    title: 'Generated test bytes',
  });
  const romBytes = new Uint8Array(32);
  romBytes.set([0x4e, 0x45, 0x53, 0x1a]);
  const rom = await phone.upload({
    libraryId: library.id,
    itemId: item.id,
    kind: 'rom',
    displayName: 'Generated.nes',
    relativePath: 'Generated.nes',
    baseRevision: item.revision,
    body: romBytes,
  });
  const battery = await phone.upload({
    libraryId: library.id,
    itemId: item.id,
    kind: 'battery_save',
    displayName: 'Generated.sav',
    relativePath: 'Generated.sav',
    baseRevision: (await phone.manifest(item.id)).revision,
    body: new Uint8Array([10, 11]),
  });
  /** @param {Uint8Array<ArrayBuffer>} bytes */
  const importer = async (bytes) => {
    assert.equal(
      new TextDecoder().decode(bytes),
      loader,
      'protected generated loader reached importer',
    );
    return {
      /** @param {Parameters<Awaited<ReturnType<typeof f.importer>>['factory']>[0]} options */
      factory: async (options) => {
        await WebAssembly.instantiate(options.wasmBinary);
        return f.runtime;
      },
      release() {},
    };
  };
  return { ...f, owner, browser, phone, device, item, rom, battery, importer };
}

test('repeated acknowledged browser saves after a phone write retain loaded baseline and both histories through the real API', async (t) => {
  const f = await setup(t);
  const base = (await f.browser.manifest(f.item.id)).revision;
  const session = await startPlayer(
    f.browser,
    { kind: 'asset', itemId: f.item.id, assetId: f.rom.id },
    {
      canvas: {},
      importer: f.importer,
      batteryAssetId: f.battery.id,
      compatibleSaves: true,
    },
  );
  assert.deepEqual(f.fs.get('/ecs/saves/game.srm'), new Uint8Array([10, 11]));
  const phoneBytes = new Uint8Array([20, 21]);
  const phone = await f.phone.upload({
    libraryId: f.item.libraryId,
    itemId: f.item.id,
    kind: 'battery_save',
    displayName: 'Generated.sav',
    relativePath: 'Generated.sav',
    baseRevision: base,
    body: phoneBytes,
  });
  /** @type {number[]} */
  const bases = [];
  const realUpload = f.browser.upload.bind(f.browser);
  f.browser.upload = (request, attempts) => {
    bases.push(request.baseRevision);
    return realUpload(request, attempts);
  };
  const copies = [];
  for (const bytes of [new Uint8Array([30, 31, 32]), new Uint8Array([40, 41, 42, 43])]) {
    f.runtime.EmscriptenSendCommand = (command) => {
      assert.equal(command, 'SAVE_FILES');
      f.fs.set('/ecs/saves/game.srm', bytes.subarray(0, 1));
      setTimeout(() => {
        f.fs.set('/ecs/saves/game.srm', bytes);
        f.replies.push('OK\n');
      }, 5);
    };
    assert.ok(session.saves);
    const copy = await session.saves.capture('battery_save');
    assert.ok(copy.conflictOf);
    assert.equal(copy.conflictOf, phone.id);
    assert.match(copy.relativePath, /^Generated\.sav\.conflict-/);
    assert.deepEqual((await f.browser.collect(copy.id)).bytes, bytes);
    copies.push(copy);
  }
  assert.deepEqual(
    bases,
    [base, base],
    'a conflict never adopts a refreshed manifest or asset revision',
  );
  const manifest = await f.browser.manifest(f.item.id);
  assert.equal(manifest.files.find((file) => file.id === phone.id)?.conflictOf, null);
  assert.deepEqual((await f.browser.collect(phone.id)).bytes, phoneBytes);
  assert.deepEqual((await f.browser.collect(f.battery.id)).bytes, new Uint8Array([10, 11]));
  for (const copy of copies)
    assert.ok(manifest.files.some((file) => file.id === copy.id && file.conflictOf === phone.id));
  const changes = await f.browser.changes({ cursor: '0', limit: 100 });
  for (const copy of copies)
    assert.ok(
      changes.changes.some(
        (change) => change.entityId === copy.id && change.entityType === 'asset',
      ),
    );
});

test('read-only bearer plays through protected loading and retains forbidden upload bytes for export', async (t) => {
  const f = await setup(t);
  const reader = await f.device('reader', ['read']);
  const session = await startPlayer(
    reader,
    { kind: 'asset', itemId: f.item.id, assetId: f.rom.id },
    {
      canvas: {},
      importer: f.importer,
      batteryAssetId: f.battery.id,
      compatibleSaves: true,
    },
  );
  assert.ok(session.saves);
  f.fs.set('/ecs/saves/game.srm', new Uint8Array([70, 71]));
  await assert.rejects(
    session.saves.capture('battery_save'),
    (error) => error instanceof ContentError && error.status === 403,
  );
  assert.deepEqual(session.saves.exportPending(), new Uint8Array([70, 71]));
  assert.equal(session.saves.pending?.baseRevision, session.prepared.revision);
});

test('Retry recovers the same committed logical save after all completion responses are lost', async (t) => {
  const f = await setup(t);
  const session = await startPlayer(
    f.browser,
    { kind: 'asset', itemId: f.item.id, assetId: f.rom.id },
    {
      canvas: {},
      importer: f.importer,
      batteryAssetId: f.battery.id,
      compatibleSaves: true,
    },
  );
  assert.ok(session.saves);
  f.fs.set('/ecs/saves/game.srm', new Uint8Array([80, 81, 82]));
  const realFetch = globalThis.fetch;
  let lost = 3;
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    if (init?.method === 'POST' && /\/uploads\/[^/]+\/complete$/.test(String(input)) && lost > 0) {
      lost -= 1;
      await response.body?.cancel();
      throw new TypeError('generated lost completion response');
    }
    return response;
  };
  try {
    await assert.rejects(session.saves.capture('battery_save'));
    assert.deepEqual(session.saves.exportPending(), new Uint8Array([80, 81, 82]));
    const revisionAfterCommit = (await f.browser.manifest(f.item.id)).revision;
    const recovered = await session.saves.retry();
    assert.deepEqual((await f.browser.collect(recovered.id)).bytes, new Uint8Array([80, 81, 82]));
    assert.equal(
      (await f.browser.manifest(f.item.id)).revision,
      revisionAfterCommit,
      'retry must not create a second asset',
    );
    assert.equal(session.saves.pending, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
