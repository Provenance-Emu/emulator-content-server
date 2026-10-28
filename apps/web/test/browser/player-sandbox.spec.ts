import { resolve } from 'node:path';
import { build } from 'vite';
import { expect, test } from './fixture';

let harness = '';
test.beforeAll(async () => {
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: { entry: resolve('src/player/runtime.ts'), formats: ['es'] },
    },
  });
  const output = Array.isArray(built) ? built[0] : built;
  if (!output || !('output' in output)) throw new Error('Missing runtime harness');
  const entry = output.output.find((x) => x.type === 'chunk' && x.isEntry);
  if (entry?.type !== 'chunk') throw new Error('Missing runtime entry');
  harness = entry.code;
});
test('plugin runtime runs WASM behind an opaque frame and cannot read app storage or document', async ({
  page,
  fixture,
}) => {
  await page.route('**/ui/player-runtime-test.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: harness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  const result = await page.evaluate(async () => {
    localStorage.setItem('ecs.private-sandbox-test', 'generated-secret');
    const api = await import('/ui/player-runtime-test.js');
    const logs: string[] = [];
    const loader = new TextEncoder().encode(`export default async options=>{
    await WebAssembly.instantiate(options.wasmBinary);
    try { options.print('storage:'+localStorage.getItem('ecs.private-sandbox-test')); } catch { options.print('storage:blocked'); }
    try { options.print('parent:'+parent.document.title); } catch { options.print('parent:blocked'); }
    const files=new Map();return {FS:{mkdirTree(){},writeFile(p,b){files.set(p,new Uint8Array(b));},readFile(p){return files.get(p);}},callMain(){options.print('main');},EmscriptenSendCommand(){},EmscriptenReceiveCommandReply(){}};
  }`);
    const loaded = await api.importBrowserRuntime(loader, { assets: [] });
    const runtime = await loaded.factory({
      wasmBinary: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      canvas: document.querySelector('canvas'),
      noInitialRun: true,
      noExitRuntime: true,
      locateFile: (s: string) => s,
      print: (s: string) => logs.push(s),
      printErr: (s: string) => logs.push(s),
    });
    await runtime.FS.mkdirTree('/ecs/content');
    await runtime.FS.writeFile('/ecs/content/game.nes', new Uint8Array([1, 2, 3]));
    await runtime.callMain(['/ecs/content/game.nes']);
    const bytes = await runtime.FS.readFile('/ecs/content/game.nes');
    const frame = document.querySelector('iframe');
    const sandbox = frame?.getAttribute('sandbox');
    loaded.release();
    return {
      logs,
      bytes: Array.from(bytes),
      sandbox,
      remaining: document.querySelectorAll('iframe').length,
      secret: localStorage.getItem('ecs.private-sandbox-test'),
    };
  });
  expect(result.logs).toEqual(['storage:blocked', 'parent:blocked', 'main']);
  expect(result.bytes).toEqual([1, 2, 3]);
  expect(result.sandbox).toBe('allow-scripts');
  expect(result.remaining).toBe(0);
  expect(result.secret).toBe('generated-secret');
});

test('installed plugin is selected for its system and executes declared WASM/data behind the player UI', async ({
  page,
  fixture,
}) => {
  const item = await fixture.client.createItem({
    libraryId: fixture.library.id,
    title: 'Generated handheld game',
    systemIdentifier: 'com.provenance.gba',
    md5: null,
    crc: null,
  });
  const asset = await fixture.client.upload({
    libraryId: fixture.library.id,
    itemId: item.id,
    kind: 'rom',
    displayName: 'generated.gba',
    relativePath: 'generated.gba',
    baseRevision: item.revision,
    body: new Uint8Array([7, 8, 9]),
  });
  await page.addInitScript(
    ({ origin, session }) =>
      localStorage.setItem(`ecs.session:${encodeURIComponent(origin)}`, JSON.stringify(session)),
    { origin: fixture.origin, session: fixture.session },
  );
  await page.goto(
    `${fixture.origin}/play/?item=${item.id}&asset=${asset.id}&profile=org.example.generated-gba`,
  );
  await expect(page.getByRole('heading', { name: 'Session setup' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Emulator', exact: true })).toHaveValue(
    'org.example.generated-gba',
  );
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByText('Runtime messages', { exact: true }).click();
  await expect(page.getByText('WASM tick: 8', { exact: true })).toBeVisible();
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(page.getByRole('button', { name: 'Save battery', exact: true })).toHaveCount(0);
  const policy = await page.request.get(`${fixture.origin}/play/`);
  expect(policy.headers()['content-security-policy']).toContain("frame-src 'self'");
  expect(policy.headers()['content-security-policy']).not.toContain('wasm-unsafe-eval');
});

test('sandbox blocks privileged network reads and releases stalled startup on cancellation', async ({
  page,
  fixture,
}) => {
  await page.route('**/ui/player-runtime-test.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: harness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  const result = await page.evaluate(async () => {
    const api = await import('/ui/player-runtime-test.js');
    const logs: string[] = [];
    const options = {
      wasmBinary: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      canvas: document.querySelector('canvas'),
      noInitialRun: true,
      noExitRuntime: true,
      locateFile: (s: string) => s,
      print: (s: string) => logs.push(s),
      printErr: (s: string) => logs.push(s),
    };
    const loader = new TextEncoder().encode(
      `export default async options=>{try{await fetch('/api/v1/devices');options.print('network:allowed');}catch{options.print('network:blocked');} const fs={mkdirTree(){},writeFile(){},readFile(){return new Uint8Array(0);}};return{FS:fs,callMain(){},EmscriptenSendCommand(){},EmscriptenReceiveCommandReply(){}};}`,
    );
    const ready = await api.importBrowserRuntime(loader);
    await ready.factory(options);
    ready.release();
    const controller = new AbortController();
    const stalled = await api.importBrowserRuntime(
      new TextEncoder().encode('export default()=>new Promise(()=>{});'),
      { signal: controller.signal },
    );
    const starting = stalled.factory(options);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const cancelled = await starting.then(
      () => false,
      () => true,
    );
    stalled.release();
    return { logs, cancelled, remaining: document.querySelectorAll('iframe').length };
  });
  expect(result.logs).toContain('network:blocked');
  expect(result.logs).not.toContain('network:allowed');
  expect(result.cancelled).toBe(true);
  expect(result.remaining).toBe(0);
});
