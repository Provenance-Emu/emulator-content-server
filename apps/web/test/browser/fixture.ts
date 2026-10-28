import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContentClient } from '@ecs/client';
import { test as base, expect } from '@playwright/test';
import { openServer } from '../../../server/dist/src/index.js';

async function createFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ecs-browser-')));
  // A generated non-emulating core proves navigation/profile gating, never emulator execution.
  const playerDir = join(directory, 'player');
  const loader = 'export default async () => ({ FS: {} });\n';
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  await mkdir(playerDir).catch(async (error) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  await Promise.all([
    writeFile(join(playerDir, 'fceumm_libretro.js'), loader),
    writeFile(join(playerDir, 'fceumm_libretro.wasm'), wasm),
    writeFile(
      join(playerDir, 'core.json'),
      JSON.stringify({
        version: 1,
        id: 'fceumm',
        name: 'Generated navigation fixture',
        systems: ['com.provenance.nes'],
        runtime: 'retroarch-emscripten-esm',
        threaded: false,
        filesystem: 'memfs',
        saveCompletion: 'command-reply-v1',
        frontendCommit: '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66',
        coreCommit: 'ac0d00a7fc01166f84c7bac01d1084ebfd2b865e',
        emscriptenVersion: '3.1.46',
        contentExtension: 'nes',
        maxContentBytes: 1024,
        loader: { file: 'fceumm_libretro.js', sha256: hash(loader) },
        wasm: { file: 'fceumm_libretro.wasm', sha256: hash(wasm) },
      }),
    ),
  ]).catch(async (error) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  // Generated WASM fixture executes a tiny integer function; it is not an emulator/ROM.
  const pluginsDir = join(directory, 'players'),
    pluginDir = join(pluginsDir, 'generated');
  await mkdir(pluginDir, { recursive: true });
  const pluginWasm = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 127, 1, 127, 3, 2, 1, 0, 7, 8, 1, 4, 116, 105, 99,
    107, 0, 0, 10, 9, 1, 7, 0, 32, 0, 65, 1, 106, 11,
  ]);
  const pluginLoader = `export default async options=>{ const {instance}=await WebAssembly.instantiate(options.wasmBinary); const packageBytes=new Uint8Array(options.getPreloadedPackage('support.data')); if(packageBytes[0]!==4)throw Error('missing package'); const files=new Map(); return {FS:{mkdirTree(){},writeFile(path,bytes){files.set(path,new Uint8Array(bytes));},readFile(path){return files.get(path);}},callMain(args){const content=files.get(args[0]);options.print('WASM tick: '+instance.exports.tick(content[0]));const ctx=options.canvas.getContext('2d');ctx.fillStyle='#79b6d9';ctx.fillRect(0,0,320,240);}}; };`;
  const support = new Uint8Array([4, 5]);
  await Promise.all([
    writeFile(join(pluginDir, 'loader.js'), pluginLoader),
    writeFile(join(pluginDir, 'core.wasm'), pluginWasm),
    writeFile(join(pluginDir, 'support.data'), support),
    writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        id: 'org.example.generated-gba',
        name: 'Generated WASM test',
        kind: 'player',
        version: '1',
        engine: 'ecs.plugin/1',
        apps: ['org.example.test'],
        player: {
          systems: ['com.provenance.gba'],
          module: 'core.wasm',
          web: {
            profileVersion: 1,
            runtime: 'emscripten-esm-v1',
            filesystem: 'memfs',
            threaded: false,
            saveCompletion: 'none',
            contentExtensions: ['gba'],
            maxContentBytes: 1024,
            buildVersion: 'generated-test',
            loader: { file: 'loader.js', sha256: hash(pluginLoader) },
            wasm: { file: 'core.wasm', sha256: hash(pluginWasm) },
            assets: [{ name: 'support.data', file: 'support.data', sha256: hash(support) }],
          },
        },
      }),
    ),
  ]);
  const server = await openServer({
    dataDir: join(directory, 'data'),
    uiDir: resolve('dist'),
    localTrust: false,
    logger: false,
    webdavEnabled: true,
    playerDir,
    playerPluginsDir: pluginsDir,
  }).catch(async (error) => {
    await rm(directory, { recursive: true, force: true });
    throw error;
  });
  try {
    const bootstrap = randomBytes(32).toString('hex');
    server.catalog.saveBootstrapHash(createHash('sha256').update(bootstrap).digest('hex'));
    const requests: string[] = [];
    server.app.addHook('onRequest', async (request) => {
      requests.push(`${request.method} ${request.url.split('?')[0]}`);
    });
    const origin = await server.app.listen({ port: 0, host: '127.0.0.1' });
    const client = new ContentClient(origin);
    const password = randomBytes(24).toString('hex');
    const session = await client.bootstrap(bootstrap, 'browser-owner', password);
    const owner = server.catalog.listUsers()[0];
    if (!owner) throw new Error('Fixture owner missing');
    const library = await client.createLibrary({ name: 'Arcade' });
    const empty = await client.createLibrary({ name: 'Empty shelf' });
    const games = [];
    for (let index = 0; index < 120; index++)
      games.push(
        server.catalog.createItem({
          libraryId: library.id,
          title: `Game ${String(index).padStart(3, '0')}`,
          systemIdentifier: 'com.provenance.nes',
          md5: null,
          crc: null,
          actorId: owner.id,
        }),
      );
    const game = games[0];
    if (!game) throw new Error('Fixture game missing');
    for (const [kind, name] of [
      ['rom', 'sample.nes'],
      ['battery_save', 'sample.sav'],
      ['screenshot', 'sample.png'],
      ['bios', 'sample.bin'],
    ] as const) {
      const current = await client.manifest(game.id);
      await client.upload({
        libraryId: library.id,
        itemId: game.id,
        kind,
        displayName: name,
        relativePath: name,
        baseRevision: current.revision,
        body: new Uint8Array([1, 2, 3, 4]),
        chunkBytes: 4,
      });
    }
    const reader = await client.createUser({ username: 'browser-reader', password });
    server.catalog.setMember(library.id, reader.id, 'reader', owner.id);
    const readerClient = new ContentClient(origin);
    const readerSession = await readerClient.login('browser-reader', password);
    return {
      ...server,
      origin,
      client,
      session,
      readerSession,
      password,
      library,
      empty,
      game,
      directory,
      requests,
      async artwork() {
        const current = await client.manifest(game.id);
        return client.upload({
          libraryId: library.id,
          itemId: game.id,
          kind: 'artwork',
          displayName: 'cover.png',
          relativePath: 'cover.png',
          baseRevision: current.revision,
          body: new Uint8Array(
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
              'base64',
            ),
          ),
        });
      },
      async legacy(name = 'external.nes') {
        const folder = join(directory, randomBytes(6).toString('hex'));
        await mkdir(folder);
        await writeFile(join(folder, name), new Uint8Array([78, 69, 83, 26, 0, 0, 0, 0]));
        const root = await client.addRoot({ path: folder, label: 'External folder' });
        await client.scanRoot(root.id);
        return root;
      },
      async dispose() {
        try {
          await server.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await server.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
export const test = base.extend<{ fixture: Awaited<ReturnType<typeof createFixture>> }>({
  page: async ({ page }, use) => {
    // Most cases exercise normal browser downloads, including browsers without a secure save picker.
    // Streaming cases install an explicit controlled picker on the already loaded document.
    await page.addInitScript(() =>
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        writable: true,
        value: undefined,
      }),
    );
    await use(page);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a pattern for a fixture with no dependencies.
  fixture: async ({}, use) => {
    const fixture = await createFixture();
    try {
      await use(fixture);
    } finally {
      await fixture.dispose();
    }
  },
});
export { expect };
export async function signIn(
  page: import('@playwright/test').Page,
  fixture: Awaited<ReturnType<typeof createFixture>>,
  reader = false,
) {
  await page.addInitScript(
    ({ origin, session }) =>
      localStorage.setItem(`ecs.session:${encodeURIComponent(origin)}`, JSON.stringify(session)),
    { origin: fixture.origin, session: reader ? fixture.readerSession : fixture.session },
  );
  await page.goto(`${fixture.origin}/ui/`);
}

/** Follow the same visible import choices a user sees; never click hidden controls. */
export async function openAddContent(
  page: import('@playwright/test').Page,
  choice: 'Upload files' | 'Upload folder' | 'Add server folder' = 'Upload files',
) {
  await page.getByRole('button', { name: /^Add (games|files)$/ }).click();
  await page
    .getByRole('dialog', { name: /^Add (games|files)$/ })
    .getByRole('button', { name: choice, exact: true })
    .click();
}

export async function libraryTool(
  page: import('@playwright/test').Page,
  name: 'Match library' | 'Refresh',
) {
  const tools = page.locator('.library-tools');
  if (!(await tools.evaluate((element) => (element as HTMLDetailsElement).open)))
    await tools.locator('summary').click();
  await tools.getByRole('button', { name, exact: true }).click();
}
