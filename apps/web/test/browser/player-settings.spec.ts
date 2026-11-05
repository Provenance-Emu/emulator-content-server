import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { build } from 'vite';
import { expect, test } from './fixture';

declare global {
  interface Window {
    settingsView: ReturnType<typeof import('./settings-view-harness').mountSettings>;
  }
}

// These bridge/component fixtures draw 2D; real GL acceptance runs separately.
test.use({ headless: true });
test.setTimeout(60000);

let harness = '';
let viewHarness = '';
test.beforeAll(async () => {
  const entryPath = resolve('settings-harness');
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'settings-harness',
        resolveId(id) {
          if (id === entryPath) return id;
        },
        load(id) {
          if (id === entryPath)
            return `export {importBrowserRuntime} from ${JSON.stringify(resolve('src/player/runtime.ts'))};export {CommandChannel} from ${JSON.stringify(resolve('src/player/commands.ts'))};`;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: { entry: entryPath, formats: ['es'] },
    },
  });
  const out = Array.isArray(built) ? built[0] : built;
  const entry = out?.output.find((x) => x.type === 'chunk' && x.isEntry);
  if (entry?.type !== 'chunk') throw Error('No settings harness');
  harness = entry.code;
  const view = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [svelte()],
    resolve: { conditions: ['browser'] },
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: { entry: resolve('test/browser/settings-view-harness.ts'), formats: ['es'] },
    },
  });
  const viewOut = Array.isArray(view) ? view[0] : view;
  const viewEntry = viewOut?.output.find((x) => x.type === 'chunk' && x.isEntry);
  if (viewEntry?.type !== 'chunk') throw Error('No component harness');
  viewHarness = viewEntry.code;
});
test('settings bridge discovers real exports, bounds option commands and recovers from shader failure', async ({
  page,
  fixture,
}) => {
  await page.route('**/ui/settings-test.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: harness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  const result = await page.evaluate(async () => {
    const api = await import('/ui/settings-test.js');
    const logs: string[] = [];
    const loader = new TextEncoder().encode(`export default async options=>{
      let arg='',value='Auto';const replies=[],files=new Map();
      const m={canvas:options.canvas,FS:{mkdirTree(){},writeFile(p,b){files.set(p,b)},readFile(p){return files.get(p)}},
      stringToNewUTF8(s){arg=s;return 123},_free(p){options.print('free:'+p)},_cmd_set_shader(p){options.print('shader:'+arg);return !arg.includes('lcd')},
      EmscriptenSendCommand(command){if(command==='GET_CORE_OPTION')replies.push('region\\t'+value+'\\tRegion\\n'+Array.from({length:120},(_,i)=>'option'+i+'\\ta\\tA legitimate long core option description\\n').join(''));else if(command==='GET_CORE_OPTION region')replies.push('region\\t'+value+'\\tRegion\\tAuto|PAL\\n');else if(command==='GET_CORE_OPTION late_error'){options.printErr('GLSL shader compilation failed');replies.push('late_error\\ta\\tLate failure\\ta|b\\n')}else if(command==='SET_CORE_OPTION region PAL'){value='PAL';replies.push('region\\tPAL\\tRegion\\n')}else if(command==='SAVE_FILES')replies.push('OK');else throw Error('Unexpected test command');},EmscriptenReceiveCommandReply(){return replies.shift()},
      callMain(){const ctx=options.canvas.getContext('2d');function draw(){ctx.fillStyle='#446699';ctx.fillRect(0,0,640,480);m.postMainLoop?.();requestAnimationFrame(draw)}draw()}};return m;}`);
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
    await runtime.callMain([]);
    await runtime.focus();
    const capability = await runtime.settingsInfo();
    const channel = new api.CommandChannel(runtime);
    const options = await channel.listOptions();
    const changed = await channel.setOption('region', 'PAL');
    await channel.run('SAVE_FILES');
    let invalid = false;
    try {
      await runtime.setShader('../../evil');
    } catch {
      invalid = true;
    }
    const applied = await runtime.setShader('scanlines');
    const failed = await runtime.setShader('lcd');
    const off = await runtime.setShader('off');
    await channel.run('SAVE_FILES');
    await runtime.setShader('scanlines');
    await channel.option('late_error');
    const late = await runtime.settingsInfo();
    loaded.release();
    return { capability, options, changed, invalid, applied, failed, off, late, logs };
  });
  expect(result.capability).toMatchObject({ commands: true, shaders: true });
  expect(result.options).toHaveLength(121);
  expect(result.options[0]).toEqual({ key: 'region', value: 'Auto', description: 'Region' });
  expect(result.changed.value).toBe('PAL');
  expect(result.invalid).toBe(true);
  expect(result.applied).toEqual({ selection: 'scanlines', status: 'requested' });
  expect(result.failed).toEqual({ selection: 'off', status: 'failed' });
  expect(result.off).toEqual({ selection: 'off', status: 'off' });
  expect(result.late.shaderResult).toEqual({ selection: 'off', status: 'failed' });
  expect(result.logs.filter((s: string) => s.startsWith('free:'))).toHaveLength(6);
  expect(result.logs.some((s: string) => s.includes('evil'))).toBe(false);
});

test('playback without settings helpers explicitly reports unavailable capabilities', async ({
  page,
  fixture,
}) => {
  await page.route('**/ui/settings-test.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: harness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  const result = await page.evaluate(async () => {
    const api = await import('/ui/settings-test.js');
    const loaded = await api.importBrowserRuntime(
      new TextEncoder().encode(
        'export default async()=>({FS:{mkdirTree(){},writeFile(){},readFile(){return new Uint8Array()}},callMain(){}})',
      ),
      { profile: { saveCompletion: 'none' }, assets: [] },
    );
    const runtime = await loaded.factory({
      wasmBinary: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      canvas: document.querySelector('canvas'),
      noInitialRun: true,
      noExitRuntime: true,
      locateFile: (s: string) => s,
      print() {},
      printErr() {},
    });
    await runtime.callMain([]);
    const info = await runtime.settingsInfo();
    loaded.release();
    return info;
  });
  expect(result).toMatchObject({ commands: false, shaders: false });
});

test('legacy save-only helpers do not trigger an unsupported settings probe', async ({
  page,
  fixture,
}) => {
  await page.route('**/ui/settings-test.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: harness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  const result = await page.evaluate(async () => {
    const api = await import('/ui/settings-test.js');
    const loaded = await api.importBrowserRuntime(
      new TextEncoder().encode(
        'export default async()=>({FS:{mkdirTree(){},writeFile(){},readFile(){return new Uint8Array()}},callMain(){},EmscriptenSendCommand(){},EmscriptenReceiveCommandReply(){}})',
      ),
      { assets: [] },
    );
    const runtime = await loaded.factory({
      wasmBinary: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      canvas: document.querySelector('canvas'),
      noInitialRun: true,
      noExitRuntime: true,
      locateFile: (s: string) => s,
      print() {},
      printErr() {},
    });
    const info = await runtime.settingsInfo();
    loaded.release();
    return info;
  });
  expect(result).toMatchObject({ commands: false, shaders: false });
});

async function mountView(
  page: import('@playwright/test').Page,
  fixture: Parameters<typeof import('./fixture').signIn>[1],
) {
  const core = await fixture.client.playerProfile('org.example.generated-gba');
  await page.route('**/ui/settings-view-test.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: viewHarness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  await page.evaluate(async (core) => {
    const api = await import('/ui/settings-view-test.js');
    window.settingsView = api.mountSettings(core);
  }, core);
  const settings = page.getByRole('region', { name: 'Core options and shaders' });
  await expect(
    settings.getByRole('button', { name: 'Remember for this game', exact: true }),
  ).toBeEnabled();
  return settings;
}
test('remembering game changes keeps unrelated inherited core keys out of the game scope', async ({
  page,
  fixture,
}) => {
  const settings = await mountView(page, fixture);
  await settings.getByRole('button', { name: 'Remember for this game', exact: true }).click();
  const prefs = await page.evaluate(() => {
    window.settingsView.updateCore();
    return window.settingsView.preferences();
  });
  expect(prefs.options).toEqual({ region: 'Auto', palette: 'rgb' });
});
test('a failed game focus leaves the applied shader selection unchanged', async ({
  page,
  fixture,
}) => {
  const settings = await mountView(page, fixture);
  await page.evaluate(() => window.settingsView.failFocus());
  const shader = settings.getByRole('combobox', { name: 'Shader preset', exact: true });
  await shader.selectOption('scanlines');
  await expect(settings.getByRole('alert')).toContainText('Game focus unavailable');
  await expect(shader).toHaveValue('off');
});
test('a deferred shader failure is shown and removes the failed remembered shader', async ({
  page,
  fixture,
}) => {
  const settings = await mountView(page, fixture);
  await settings
    .getByRole('combobox', { name: 'Shader preset', exact: true })
    .selectOption('scanlines');
  await expect(settings.getByText(/Scanlines requested/)).toBeVisible();
  await settings.getByRole('button', { name: 'Remember for this game', exact: true }).click();
  await page.evaluate(() => window.settingsView.failShader());
  await expect(settings.getByRole('alert')).toContainText(/failed/i);
  expect((await page.evaluate(() => window.settingsView.preferences())).shader).toBe('off');
});
