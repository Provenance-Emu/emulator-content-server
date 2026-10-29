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

test('capture bridge returns current PNG pixels, clears stale previews and applies display settings', async ({
  page,
  fixture,
}) => {
  await page.route('**/ui/player-runtime-test.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: harness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  const result = await page.evaluate(async () => {
    const api = await import('/ui/player-runtime-test.js');
    const loaded = await api.importBrowserRuntime(
      new TextEncoder().encode(`export default async options=>{
      const files=new Map(); let color='rgb(20,40,200)'; const m={canvas:options.canvas,
      FS:{mkdirTree(){},writeFile(p,b){files.set(p,new Uint8Array(b));if(p==='/ecs/color')color='rgb(200,40,20)';},readFile(p){if(!files.has(p))throw Error('missing');return files.get(p);},unlink(p){files.delete(p);}},
      callMain(){const ctx=options.canvas.getContext('2d');function draw(){ctx.fillStyle=color;ctx.fillRect(0,0,options.canvas.width,options.canvas.height);m.postMainLoop?.();requestAnimationFrame(draw);}draw();},EmscriptenSendCommand(){},EmscriptenReceiveCommandReply(){}};return m;};`),
    );
    const runtime = await loaded.factory({
      wasmBinary: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      canvas: document.querySelector('canvas'),
      noInitialRun: true,
      noExitRuntime: true,
      print() {},
      printErr() {},
      locateFile: (s) => s,
    });
    await runtime.callMain([]);
    const first = await runtime.captureScreenshot();
    await runtime.FS.writeFile('/ecs/color', new Uint8Array([1]));
    const second = await runtime.captureScreenshot();
    const pixel = async (bytes) => {
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const p = Array.from(ctx.getImageData(0, 0, 1, 1).data);
      bitmap.close();
      return p;
    };
    await runtime.FS.writeFile('/ecs/states/game.state.png', first);
    await runtime.prepareStatePreview();
    let removed = false;
    try {
      await runtime.FS.readFile('/ecs/states/game.state.png');
    } catch {
      removed = true;
    }
    await runtime.FS.writeFile('/ecs/states/game.state.png', second);
    const preview = await runtime.captureStatePreview();
    await runtime.setDisplay({ fit: 'fill', aspect: '16:9', filter: 'smooth' });
    const info = await runtime.displayInfo();
    const output = {
      first: await pixel(first),
      second: await pixel(second),
      preview: await pixel(preview),
      removed,
      info,
    };
    loaded.release();
    return output;
  });
  expect(result.first).toEqual([20, 40, 200, 255]);
  expect(result.second).toEqual([200, 40, 20, 255]);
  expect(result.preview).toEqual(result.second);
  expect(result.removed).toBe(true);
  expect(result.info.settings).toEqual({ fit: 'fill', aspect: '16:9', filter: 'smooth' });
});

test('preview bridge ignores stable incomplete bytes until the native writer finishes', async ({
  page,
  fixture,
}) => {
  await page.route('**/ui/player-runtime-test.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: harness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  const result = await page.evaluate(async () => {
    const api = await import('/ui/player-runtime-test.js');
    const loaded = await api.importBrowserRuntime(
      new TextEncoder().encode(
        `export default async options=>{const files=new Map();return{FS:{mkdirTree(){},unlink(p){files.delete(p);},writeFile(p,b){if(p==='/ecs/partial'){files.set('/ecs/states/game.state.png',b.slice(0,40));setTimeout(()=>files.set('/ecs/states/game.state.png',b),200);}else files.set(p,b);},readFile(p){if(!files.has(p))throw Error('missing');return files.get(p);}},callMain(){},EmscriptenSendCommand(){},EmscriptenReceiveCommandReply(){}};};`,
      ),
    );
    const runtime = await loaded.factory({
      canvas: document.querySelector('canvas'),
      wasmBinary: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      noInitialRun: true,
      noExitRuntime: true,
      locateFile: (s) => s,
      print() {},
      printErr() {},
    });
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      ),
      (c) => c.charCodeAt(0),
    );
    await runtime.prepareStatePreview();
    await runtime.FS.writeFile('/ecs/partial', bytes);
    const start = performance.now();
    const preview = await runtime.captureStatePreview();
    const output = { elapsed: performance.now() - start, size: preview.length };
    loaded.release();
    return output;
  });
  expect(result.elapsed).toBeGreaterThanOrEqual(150);
  expect(result.size).toBe(68);
});
