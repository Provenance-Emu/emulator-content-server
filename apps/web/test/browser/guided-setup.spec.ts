import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { ManagedPluginHost } from '../../../cli/dist/src/plugin-host.js';
import type { PluginManagementBridge } from '../../../server/dist/src/index.js';
import { openServer } from '../../../server/dist/src/index.js';
import { expect, test } from './fixture';

function generatedNesPackage() {
  const loader = Buffer.from(
    'export default async()=>({FS:{mkdirTree(){},writeFile(){},readFile(){return new Uint8Array()}},callMain(){}});',
  );
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const manifest = {
    id: 'org.libretro.fceumm',
    name: 'Generated NES emulator',
    kind: 'player',
    version: '1',
    engine: 'ecs.plugin/1',
    apps: ['org.example.fixture'],
    player: {
      systems: ['com.provenance.nes'],
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
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length);
  return Buffer.concat([prefix, header, loader, wasm]);
}

async function serveDesktop() {
  const root = resolve('../tray/dist');
  const desktopServer = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(`${root}/`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const content = await readFile(file);
      response
        .writeHead(200, {
          'content-type': file.endsWith('.html')
            ? 'text/html'
            : file.endsWith('.css')
              ? 'text/css'
              : 'text/javascript',
        })
        .end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done, reject) => {
    desktopServer.once('error', reject);
    desktopServer.listen(5174, '127.0.0.1', done);
  });
  return desktopServer;
}

test('first Mac setup guides account, existing default library, folder, emulator and native cleanup without CLI steps', async ({
  page,
  fixture,
}) => {
  test.setTimeout(90_000);
  const data = join(fixture.directory, 'fresh-data');
  const games = join(fixture.directory, 'fresh-games');
  await mkdir(games);
  await writeFile(
    join(games, 'generated.nes'),
    new Uint8Array([78, 69, 83, 26, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  );
  let host: ManagedPluginHost;
  const bridge: PluginManagementBridge = {
    view: () => host.view(),
    installDefaults: () => host.installDefaults(),
    configure: (configuration) => host.configure(configuration),
    connect: (id, token) => host.connect(id, token),
    doctor: () => host.doctor(),
  };
  const fresh = await openServer({
    dataDir: data,
    pluginManagement: bridge,
    localTrust: false,
    automaticMatching: false,
  });
  const bootstrap = { token: randomBytes(32).toString('base64url') };
  fresh.catalog.saveBootstrapHash(createHash('sha256').update(bootstrap.token).digest('hex'));
  const origin = await fresh.app.listen({ host: '127.0.0.1', port: 0 });
  host = new ManagedPluginHost(join(data, 'plugin-host'), origin);
  const desktopServer = await serveDesktop();
  let emulatorInstalls = 0;
  // Every virtual default-port request goes to this disposable server, never the operator's server.
  await page.route('http://127.0.0.1:8473/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/player/management/install/org.libretro.fceumm') {
      emulatorInstalls++;
      const headers = {
        ...request.headers(),
        'content-type': 'application/vnd.ecs.player-package',
      };
      delete headers['content-length'];
      const response = await route.fetch({
        url: `${origin}/api/v1/player/management/install`,
        headers,
        postData: generatedNesPackage(),
      });
      return route.fulfill({ response });
    }
    return route.fulfill({
      response: await route.fetch({
        url: origin + path + new URL(request.url()).search,
        timeout: 30000,
      }),
    });
  });
  await page.addInitScript(
    ({ code, games }) => {
      Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
      const state = { installed: false, installs: 0, shown: false, focused: false };
      Object.assign(window, {
        __guideNative: state,
        __TAURI_INTERNALS__: {
          async invoke(command: string) {
            if (command === 'plugin:window|get_all_windows') return ['status', 'library'];
            if (command === 'plugin:window|show') {
              state.shown = true;
              return;
            }
            if (command === 'plugin:window|set_focus') {
              state.focused = true;
              return;
            }
            if (command === 'managed_endpoint')
              return state.installed
                ? {
                    available: true,
                    origin: 'http://127.0.0.1:8473',
                    verificationId: 'generated-identity',
                  }
                : { available: false, reason: 'Not installed yet' };
            if (command === 'install_local_server') {
              state.installed = true;
              state.installs++;
              return code;
            }
            if (command === 'validate_managed_selection') return true;
            if (command === 'choose_managed_directory') return games;
            throw new Error('Unexpected setup command');
          },
        },
      });
    },
    { code: bootstrap.token, games },
  );
  try {
    await page.goto('http://127.0.0.1:5174/library.html');
    await expect(
      page.getByRole('heading', { name: 'Let’s set up your game library', exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __guideNative: { shown: boolean; focused: boolean } })
              .__guideNative,
        ),
      )
      .toMatchObject({ shown: true, focused: true });
    await page.getByRole('button', { name: 'Set up this computer', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
    await expect(page.getByLabel('Setup code', { exact: true })).toHaveCount(0);
    await page.getByLabel('Username', { exact: true }).fill('guide-owner');
    await page.getByLabel('Password', { exact: true }).fill('generated-guide-password');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(
      page.getByText('You’re signed in and can set up this library.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Choose games folder', exact: true }).click();
    await expect(page.getByText('· 1 file found', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page
      .getByRole('button', { name: 'Install suggested emulators (1)', exact: true })
      .click();
    await expect(
      page.getByText('Your installed emulators cover the consoles we found.', { exact: true }),
    ).toBeVisible();
    expect(emulatorInstalls).toBe(1);
    await page.getByRole('button', { name: 'Finish later', exact: true }).click();
    await page.getByRole('button', { name: 'Setup guide', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Play your games', exact: true })).toBeVisible();
    await expect(
      page.getByText('Your installed emulators cover the consoles we found.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Install library cleanup', exact: true }).click();
    await expect(page.getByText('Library cleanup is enabled.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Open your library', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Open generated.nes', exact: true }),
    ).toBeVisible();
    expect(fresh.catalog.listLibraries('fixture', true)).toHaveLength(1);
    expect((await host.view()).running).toBe(true);
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Open generated.nes', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Let’s set up your game library', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Setup guide', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ready', exact: true })).toBeVisible();
  } finally {
    await page.context().close();
    await host.close();
    await fresh.close();
    await new Promise<void>((done, reject) =>
      desktopServer.close((error) => (error ? reject(error) : done())),
    );
  }
});

test('joining another computer guides sign-in and library choice and remembers completion', async ({
  page,
  fixture,
}) => {
  const desktopServer = await serveDesktop();
  try {
    await page.goto('http://127.0.0.1:5174/library.html');
    await page.getByRole('button', { name: 'Connect to another computer', exact: true }).click();
    await page
      .getByLabel('Computer name or library address', { exact: true })
      .fill(`${fixture.origin}/ui/`);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
    await page.getByLabel('Username', { exact: true }).fill('browser-owner');
    await page.getByLabel('Password', { exact: true }).fill(fixture.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      page.getByText('You’re connected. Choose a library next and start browsing your games.', {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Arcade Use this library', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ready', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open your library', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Game 000', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Open Game 000', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toHaveCount(0);
  } finally {
    await page.context().close();
    await new Promise<void>((done, reject) =>
      desktopServer.close((error) => (error ? reject(error) : done())),
    );
  }
});
