/** Opt-in native-browser acceptance. Only generated programs and a hash-verified local profile are served. */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '../../packages/plugins/dist/src/manifest.js';
import { atari7800SmokeCartridge } from './generate-7800-smoke.mjs';
import { dreamcastSmokeElf } from './generate-sh4-smoke.mjs';

const profilePath = resolve(process.argv[2] ?? '');
const output = resolve(process.argv[3] ?? 'dist-release/safari-jit-acceptance');
if (!process.argv[2])
  throw Error('Usage: node safari-jit-acceptance.mjs PROFILE_DIRECTORY OUTPUT_DIRECTORY');
const root = fileURLToPath(new URL('../..', import.meta.url));
const manifest = parseManifest(
  JSON.parse(await readFile(join(profilePath, 'plugin.json'), 'utf8')),
);
const web = manifest.player?.web;
if (!web || web.assets.length || web.threaded || web.saveCompletion !== 'none')
  throw Error('A standalone, non-threaded test profile is required');
const resources = new Map();
for (const [name, spec] of [
  ['loader.js', web.loader],
  ['core.wasm', web.wasm],
]) {
  const bytes = await readFile(join(profilePath, spec.file));
  if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256)
    throw Error('Profile resource digest mismatch');
  resources.set(name, bytes);
}
const isFlycast = ['org.libretro.flycast', 'org.flycast.wasm-jit'].includes(manifest.id);
if (!isFlycast && manifest.id !== 'org.libretro.prosystem')
  throw Error('Only original Flycast/ProSystem acceptance programs are supported');
const extension = isFlycast ? 'elf' : 'bin';
resources.set('program', isFlycast ? dreamcastSmokeElf() : atari7800SmokeCartridge());
const nonce = randomBytes(16).toString('hex');
let sandbox = await readFile(join(root, 'apps/web/public/play/sandbox.html'), 'utf8');
// Test-only observability of aggregate JIT counters and the generated program's fixed RAM location.
// Production iframe capabilities, sandbox flags and network policy are unchanged.
const marker = "      case 'focus':";
if (!sandbox.includes(marker)) throw Error('Sandbox diagnostic hook needs review');
sandbox = sandbox.replace(
  marker,
  `      case 'acceptance-jit': {
        const pointer = runtime._fly_ram_ptr?.();
        return { mode:runtime._ecs_jit_executor_mode?.()??null, executed:runtime._ecs_jit_executed_blocks?.()??null,
          counter:Number.isInteger(pointer)&&pointer>0?new DataView(runtime.HEAPU8.buffer).getUint32(pointer+0xf800,true):null,
          frames, opaque:location.origin==='null' || self.origin==='null', isolated:crossOriginIsolated };
      }
${marker}`,
);
const policy = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'",
  'connect-src blob:',
  'img-src blob: data:',
  'media-src blob:',
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');
const parentScript = `
const nonce=${JSON.stringify(nonce)},isFlycast=${isFlycast},extension=${JSON.stringify(extension)};
const status=document.querySelector('pre'),button=document.querySelector('button'),frame=document.querySelector('iframe');
const channel=new MessageChannel(),pending=new Map(),logs=[];let next=0,connectedResolve;
const connected=new Promise(r=>connectedResolve=r);
channel.port1.onmessage=event=>{const m=event.data;if(m.type==='connected')connectedResolve();if(m.type==='log')logs.push(m.text);if(m.type==='result'){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error)):p.resolve(m.value);}}};channel.port1.start();
function rpc(op,value){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error('Runtime operation timed out: '+op));},60000);pending.set(id,{resolve,reject,timer});channel.port1.postMessage({id,op,value});});}
addEventListener('message',event=>{if(event.source===frame.contentWindow&&event.origin==='null'&&event.data?.type==='ecs-player-ready'&&event.data.nonce===nonce)frame.contentWindow.postMessage({type:'ecs-player-connect',nonce},'*',[channel.port2]);});
frame.src='./sandbox.html#'+nonce;
const bytes=name=>fetch('./'+name).then(r=>{if(!r.ok)throw Error('Resource unavailable');return r.arrayBuffer();});
const assets=Promise.all([bytes('loader.js'),bytes('core.wasm'),bytes('program')]);assets.then(()=>{button.disabled=false;button.focus();status.textContent='Ready: start the original test program.';});
button.onclick=async()=>{button.disabled=true;const start=performance.now();try{
 const [loader,wasm,program]=await assets;await connected;status.textContent='Starting opaque WASM player…';
 await rpc('init',{loader,wasm,assets:[],commands:false,shaders:{scanlines:'void main(){}',lcd:'void main(){}'},maxContentBytes:67108864});
 for(const dir of ['/ecs','/ecs/content','/ecs/saves','/ecs/states','/ecs/system'])await rpc('mkdir',dir);
 const config='video_driver = "gl"\\nvideo_vsync = "false"\\nsuspend_screensaver_enable = "false"\\naudio_driver = "rwebaudio"\\nmenu_driver = "null"\\nconfig_save_on_exit = "false"\\nsystem_directory = "/ecs/system"\\nsavefile_directory = "/ecs/saves"\\nsavestate_directory = "/ecs/states"\\ncore_options_path = "/ecs/core-options.cfg"\\n';
 await rpc('write',{path:'/ecs/config.cfg',bytes:new TextEncoder().encode(config).buffer});
 await rpc('write',{path:'/ecs/core-options.cfg',bytes:new TextEncoder().encode('reicast_hle_bios = "enabled"\\nreicast_threaded_rendering = "disabled"\\nreicast_emulate_framebuffer = "enabled"\\n').buffer});
 await rpc('write',{path:'/ecs/content/original.'+extension,bytes:program});
 await rpc('main',['-v','-c','/ecs/config.cfg','/ecs/content/original.'+extension]);
 await new Promise(r=>setTimeout(r,1500));const before=await rpc('acceptance-jit');await new Promise(r=>setTimeout(r,600));const after=await rpc('acceptance-jit');
 const screenshot=await rpc('screenshot');const bitmap=await createImageBitmap(new Blob([screenshot],{type:'image/png'})),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);const pixel=[...ctx.getImageData(canvas.width>>1,canvas.height>>1,1,1).data];bitmap.close();
 const pass=after.opaque&&after.frames>0&&pixel[1]>100&&pixel[0]<40&&pixel[2]<40&&(!isFlycast||(after.mode===6&&after.executed>before.executed&&after.counter!==before.counter));
 const result={pass,userAgent:navigator.userAgent,profile:${JSON.stringify(manifest.id)},loaderSha256:${JSON.stringify(web.loader.sha256)},wasmSha256:${JSON.stringify(web.wasm.sha256)},before,after,pixel,elapsedMs:Math.round(performance.now()-start),logs:logs.slice(-80)};
 status.textContent=(pass?'PASS':'FAIL')+'\\n'+JSON.stringify(result,null,2);await fetch('./screenshot',{method:'POST',body:screenshot});await fetch('./result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(result)});
}catch(error){const result={pass:false,userAgent:navigator.userAgent,error:String(error),logs:logs.slice(-80)};status.textContent='FAIL\\n'+JSON.stringify(result,null,2);await fetch('./result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(result)});}};
`;
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const route = req.url?.slice(`/${nonce}/`.length);
    if (
      !req.url?.startsWith(`/${nonce}/`) ||
      req.headers.host !== `127.0.0.1:${server.address().port}`
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method === 'POST' && (route === 'result' || route === 'screenshot')) {
      const limit = route === 'result' ? 65536 : 8 * 1024 * 1024;
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw Error('Acceptance response too large');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      await writeFile(join(output, route === 'result' ? 'result.json' : 'frame.png'), body, {
        mode: 0o600,
      });
      res.end('saved');
      if (route === 'result') {
        const r = JSON.parse(body);
        console.log(
          JSON.stringify({
            pass: r.pass,
            error: r.error,
            profile: r.profile,
            userAgent: r.userAgent,
            pixel: r.pixel,
            before: r.before,
            after: r.after,
          }),
        );
      }
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (resources.has(route)) {
      res.setHeader(
        'content-type',
        route === 'core.wasm' ? 'application/wasm' : 'application/octet-stream',
      );
      res.end(resources.get(route));
      return;
    }
    if (route === 'parent.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(parentScript);
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (route === 'sandbox.html') {
      res.setHeader('content-security-policy', policy);
      res.setHeader('cross-origin-embedder-policy', 'require-corp');
      res.setHeader('cross-origin-resource-policy', 'cross-origin');
      res.setHeader('origin-agent-cluster', '?1');
      res.setHeader('referrer-policy', 'no-referrer');
      res.end(sandbox);
      return;
    }
    if (route === '') {
      res.end(
        '<!doctype html><meta charset="utf-8"><title>ECS native-browser JIT acceptance</title><h1>Original-program WASM acceptance</h1><button disabled>Start test</button><pre>Loading verified plugin…</pre><iframe sandbox="allow-scripts" style="width:640px;height:480px;border:0"></iframe><script type="module" src="./parent.js"></script>',
      );
      return;
    }
    res.writeHead(404);
    res.end();
  } catch (error) {
    res.writeHead(500);
    res.end('Acceptance operation failed');
    console.error(error.message);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/${nonce}/`;
await writeFile(join(output, 'launch.json'), JSON.stringify({ url, profile: manifest.id }), {
  mode: 0o600,
});
console.log(JSON.stringify({ url, output, profile: manifest.id }));
