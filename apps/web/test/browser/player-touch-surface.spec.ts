/** Isolated bridge/UI acceptance with a synthetic 2D loader; no emulation claim. */
import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { build } from 'vite';
import type { InputInfo } from '../../src/player/input-model';
import { expect, test } from './fixture';

interface TouchSurfaceStats {
  pad: { axes: number[]; buttons: number[] };
  info: InputInfo;
  ready: boolean;
  epoch: number;
  focus: boolean;
  trace: unknown[];
}
declare global {
  interface Window {
    touchSurfaceHarness?: { stats(): Promise<TouchSurfaceStats>; dispose(): Promise<void> };
  }
}

test.use({ headless: true, launchOptions: { args: ['--mute-audio'] } });
test.setTimeout(120000);
let harness = '';
test.beforeAll(async () => {
  const id = resolve('touch-surface-test-harness');
  const source = `
import {mount,unmount,tick} from 'svelte';
import TouchSurface from ${JSON.stringify(resolve('src/player/TouchSurface.svelte'))};
import InputControls from ${JSON.stringify(resolve('src/player/InputControls.svelte'))};
import {InputSession} from ${JSON.stringify(resolve('src/player/input-session.ts'))};
import {createInputPreferences} from ${JSON.stringify(resolve('src/player/input-preferences.ts'))};
import {importBrowserRuntime} from ${JSON.stringify(resolve('src/player/runtime.ts'))};
export async function start() {
  const root=document.createElement('div');
  root.style.cssText='position:fixed;inset:0;z-index:1000;background:#111;display:grid;grid-template-columns:800px 320px;gap:10px;align-items:start;overflow:auto';
  const stage=document.createElement('div'),gameMount=document.createElement('div'),canvas=document.createElement('canvas'),controls=document.createElement('div');
  stage.className='player-stage';stage.style.cssText='width:800px;height:500px;min-height:0;margin:0';
  gameMount.className='player-game';canvas.className='player-canvas';canvas.tabIndex=0;
  gameMount.append(canvas);stage.append(gameMount);root.append(stage,controls);document.body.append(root);
  const trace=[];
  const record=value=>{trace.push({time:performance.now(),...value});if(trace.length>100)trace.shift();};
  const loader=new TextEncoder().encode(${JSON.stringify(`export default async options=>{
    let pad={axes:[0,0,0,0],buttons:[]};
    const m={FS:{mkdirTree(){},writeFile(){},readFile(){return new TextEncoder().encode(JSON.stringify(pad));}},
    callMain(){const ctx=options.canvas.getContext('2d');function draw(){const p=navigator.getGamepads()[0];pad={axes:Array.from(p?.axes??[0,0,0,0]),buttons:Array.from(p?.buttons??[],b=>b.value)};ctx.fillStyle='#447788';ctx.fillRect(0,0,320,240);m.postMainLoop?.();requestAnimationFrame(draw);}draw();}};return m;}`)});
  const profile={profileVersion:1,id:'org.example.touch-ui',name:'Synthetic bridge/UI fixture',systems:['com.example.fixture'],runtime:'retroarch-emscripten-esm',filesystem:'memfs',threaded:false,saveCompletion:'none',defaultInputLayout:'standard',contentExtensions:['bin'],maxContentBytes:1024,buildVersion:'synthetic-ui-only',loader:{sha256:'0'.repeat(64)},wasm:{sha256:'1'.repeat(64)},assets:[]};
  const loaded=await importBrowserRuntime(loader,{profile,inputEnabled:true,timeoutMs:10000});
  let session,touchView,controlsView;
  const events=['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture'];
  const pointer=e=>{if(e.target?.closest?.('.touch-hit'))record({kind:e.type,id:e.pointerId,x:e.clientX,y:e.clientY,target:e.target.closest('.touch-hit').getAttribute('aria-label'),captured:e.target.closest('.touch-hit').hasPointerCapture(e.pointerId),focus:document.hasFocus(),epoch:session?.gestureEpoch});};
  try {
    const runtime=await loaded.factory({wasmBinary:new Uint8Array([0,97,115,109,1,0,0,0]),canvas,noInitialRun:true,noExitRuntime:true,locateFile:s=>s,print:s=>record({kind:'log',text:s}),printErr:s=>record({kind:'error',text:s})});
    const send=runtime.sendInput.bind(runtime);
    runtime.sendInput=packet=>{record({kind:'packet',packet});send(packet);};
    const storage={getItem(){return null},setItem(){},removeItem(){}};
    session=new InputSession(runtime,createInputPreferences(location.origin,profile,undefined,storage));
    touchView=mount(TouchSurface,{target:stage,props:{session,stage,gameMount}});
    controlsView=mount(InputControls,{target:controls,props:{session}});
    for(const event of events)document.addEventListener(event,pointer);
    await tick();await runtime.callMain([]);await session.initialize();await runtime.focus();await tick();
    return {
      async stats(){return {pad:JSON.parse(new TextDecoder().decode(await runtime.FS.readFile('/ecs/virtual-pad'))),info:await runtime.inputInfo(),ready:session.ready,epoch:session.gestureEpoch,focus:document.hasFocus(),trace:[...trace]};},
      async dispose(){for(const event of events)document.removeEventListener(event,pointer);session.releaseAll();await unmount(touchView);await unmount(controlsView);loaded.release();root.remove();},
    };
  } catch(error) {for(const event of events)document.removeEventListener(event,pointer);if(touchView)await unmount(touchView);if(controlsView)await unmount(controlsView);loaded.release();root.remove();throw error;}
}`;
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'touch-surface-harness',
        resolveId(value) {
          if (value === id) return value;
        },
        load(value) {
          if (value === id) return source;
        },
      },
      svelte(),
    ],
    resolve: { conditions: ['browser'] },
    build: { write: false, minify: false, target: 'es2022', lib: { entry: id, formats: ['es'] } },
  });
  const output = Array.isArray(result) ? result[0] : result;
  const chunk = output?.output.find((entry) => entry.type === 'chunk' && entry.isEntry);
  if (chunk?.type !== 'chunk') throw Error('No touch-surface harness');
  harness = chunk.code;
});

test('standard Svelte touch stick reaches the sandbox virtual pad and releases to neutral', async ({
  page,
  fixture,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/ui/touch-surface-test.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: harness }),
  );
  await page.goto(`${fixture.origin}/play/`);
  try {
    await page.evaluate(async () => {
      const api = await import('/ui/touch-surface-test.js');
      window.touchSurfaceHarness = await api.start();
    });
    const stats = () =>
      page.evaluate(() => {
        if (!window.touchSurfaceHarness) throw Error('Touch harness not started');
        return window.touchSurfaceHarness.stats();
      });
    const stick = page.getByRole('button', { name: 'Touch L stick', exact: true });
    await expect(stick).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await stats()).ready, { timeout: 10000 }).toBe(true);
    await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    const box = await stick.boundingBox();
    if (!box) throw Error('Standard touch stick has no bounds');
    const x = box.x + box.width / 2,
      y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + box.width * 0.4, y, { steps: 5 });
    await expect
      .poll(async () => (await stats()).pad.axes[0], { timeout: 15000 })
      .toBeGreaterThan(0.4);
    const held = await stats();
    expect(held.info.states[0].axes[0]).toBeGreaterThan(0.4);
    await page.mouse.up();
    await expect
      .poll(async () => (await stats()).pad.axes, { timeout: 10000 })
      .toEqual([0, 0, 0, 0]);
    const released = await stats();
    expect(released.info.states[0].axes).toEqual([0, 0, 0, 0]);
    expect(errors).toEqual([]);
    console.log(
      'Touch surface bridge/UI evidence',
      JSON.stringify({ held: held.pad.axes, released: released.pad.axes }),
    );
    await testInfo.attach('touch-surface-bridge-evidence', {
      body: JSON.stringify({ kind: 'synthetic bridge/UI only', held, released, errors }, null, 2),
      contentType: 'application/json',
    });
  } catch (error) {
    const state = await page
      .evaluate(async () => window.touchSurfaceHarness?.stats())
      .catch(() => undefined);
    console.log(
      'Touch surface bridge/UI failure',
      JSON.stringify({ errors, state, failure: String(error) }),
    );
    await testInfo.attach('touch-surface-failure', {
      body: JSON.stringify(
        { kind: 'synthetic bridge/UI only', errors, state, failure: String(error) },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    await page.mouse.up().catch(() => {});
    await page
      .evaluate(async () => {
        await window.touchSurfaceHarness?.dispose();
      })
      .catch(() => {});
    await page.goto('about:blank').catch(() => {});
  }
});
