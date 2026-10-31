/** Dedicated-origin, blob-only Dolphin proof. Serves no ECS credentials, API or filesystem. */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDolphinProbe } from './dolphin-probe.mjs';
import { dolphinVideoSmokeDol } from './dolphin-video-smoke.mjs';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(join(repository, 'apps/web/package.json'));
const { chromium } = require('@playwright/test');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const workerSource = `
self.onmessage=async event=>{
 const {loaderUrl,abiUrl,wasmBinary,dol}=event.data,logs=[];
 try {
  const {default:factory}=await import(loaderUrl);
  const wasmUrl=URL.createObjectURL(new Blob([wasmBinary],{type:'application/wasm'}));
  const {createDolphinPrototype}=await import(abiUrl);
  const host=await createDolphinPrototype({factory,wasmBinary,moduleOptions:{mainScriptUrlOrBlob:loaderUrl,print:x=>logs.push(String(x)),printErr:x=>logs.push(String(x)),locateFile:name=>{if(name==='dolphin-core-upstream.wasm')return wasmUrl;throw Error('Unexpected resource '+name);}}});
  host.bootDol(new Uint8Array(dol));
  const samples=[];let frames=0,previousSequence=0,previousRuns=0;
  const deadline=performance.now()+20000;
  while(performance.now()<deadline){
   await new Promise(r=>setTimeout(r,100));
   const current=host.poll(),frame=host.frame();
   samples.push({...current,ticks:String(current.ticks),xfb:frame?.sequence??0,videoStats:frame?.videoStats??null});
   if(frame&&frame.sequence!==previousSequence){
    frames++;previousSequence=frame.sequence;
    postMessage({type:'frame',width:frame.width,height:frame.height,rgba:frame.rgba.buffer},[frame.rgba.buffer]);
    if(frames>=3&&current.jitRuns>previousRuns){
     postMessage({type:'result',pass:true,isolated:crossOriginIsolated,sharedMemory:true,frames,samples,logs});return;
    }
    previousRuns=current.jitRuns;
   }
  }
  postMessage({type:'result',pass:false,error:'Three distinct genuine XFB frames did not arrive',frames,samples,logs});
 }catch(error){postMessage({type:'result',pass:false,error:String(error.stack||error),logs});}
};
`;

export async function runDolphinBrowserProbe(checkout, output) {
  output = resolve(output);
  const receipt = prepareDolphinProbe(checkout, output);
  const nonce = randomBytes(16).toString('hex');
  const program = dolphinVideoSmokeDol();
  await writeFile(join(output, 'original-video.dol'), program, { flag: 'wx', mode: 0o600 });
  const files = new Map([
    [
      'loader.js',
      ['application/octet-stream', await readFile(join(output, 'dolphin-core-upstream.js'))],
    ],
    ['core.wasm', ['application/wasm', await readFile(join(output, 'dolphin-core-upstream.wasm'))]],
    [
      'abi.mjs',
      ['application/octet-stream', await readFile(new URL('./dolphin-abi.mjs', import.meta.url))],
    ],
    ['original-video.dol', ['application/octet-stream', program]],
  ]);
  const companionRequests = [],
    parentRequests = [];
  let parentOrigin, companionOrigin, bootstrap, parentScript;
  const commonHeaders = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'origin-agent-cluster': '?1',
    'referrer-policy': 'no-referrer',
  };
  const companion = createServer((request, response) => {
    companionRequests.push({
      method: request.method,
      path: request.url === `/${nonce}/` ? 'bootstrap' : 'unexpected',
    });
    if (
      request.headers.host !== `127.0.0.1:${companion.address().port}` ||
      request.method !== 'GET' ||
      request.url !== `/${nonce}/`
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    const hash = createHash('sha256').update(bootstrap).digest('base64');
    response.writeHead(200, {
      ...commonHeaders,
      'content-type': 'text/html',
      'cross-origin-resource-policy': 'cross-origin',
      'content-security-policy': `default-src 'none'; script-src 'sha256-${hash}' blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors ${parentOrigin}`,
    });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Isolated Dolphin runtime</title><canvas width="320" height="240"></canvas><script>${bootstrap}</script>`,
    );
  });
  const parent = createServer((request, response) => {
    parentRequests.push(request.url?.slice(nonce.length + 2));
    if (
      request.headers.host !== `127.0.0.1:${parent.address().port}` ||
      request.method !== 'GET' ||
      !request.url?.startsWith(`/${nonce}/`)
    ) {
      response.writeHead(404);
      response.end();
      return;
    }
    const path = request.url.slice(nonce.length + 2);
    let resource = files.get(path);
    if (path === 'parent.mjs') resource = ['text/javascript', Buffer.from(parentScript)];
    if (path === '')
      resource = [
        'text/html',
        Buffer.from(
          `<!doctype html><meta charset="utf-8"><title>Dolphin original VI acceptance</title><iframe width="400" height="300" sandbox="allow-scripts allow-same-origin" allow="cross-origin-isolated" src="${companionOrigin}/${nonce}/"></iframe><pre>Booting original VI program…</pre><script type="module" src="./parent.mjs"></script>`,
        ),
      ];
    if (!resource) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      ...commonHeaders,
      'content-type': resource[0],
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': `cross-origin-isolated=(self "${companionOrigin}")`,
      'content-security-policy': `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; frame-src ${companionOrigin}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    response.end(resource[1]);
  });
  await new Promise((ready) => companion.listen(0, '127.0.0.1', ready));
  await new Promise((ready) => parent.listen(0, '127.0.0.1', ready));
  parentOrigin = `http://127.0.0.1:${parent.address().port}`;
  companionOrigin = `http://127.0.0.1:${companion.address().port}`;
  bootstrap = `
const expectedParent=${JSON.stringify(parentOrigin)},nonce=${JSON.stringify(nonce)};
addEventListener('message',function connect(event){
 if(event.source!==parent||event.origin!==expectedParent||event.data?.nonce!==nonce||event.data?.type!=='connect'||event.ports.length!==1)return;
 removeEventListener('message',connect);const port=event.ports[0],canvas=document.querySelector('canvas');let initialized=false;
 port.onmessage=async event=>{
  if(initialized)return;initialized=true;
  const {loader,abi,wasmBinary,dol}=event.data;
  const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(v=>v.toString(16).padStart(2,'0')).join('');
  if(![loader,abi,wasmBinary,dol].every(value=>value instanceof ArrayBuffer)||abi.byteLength>262144||dol.byteLength>1048576||loader.byteLength!==${files.get('loader.js')[1].length}||wasmBinary.byteLength!==15175335||await hash(loader)!==${JSON.stringify(receipt.changedLoaderSha256)}||await hash(wasmBinary)!==${JSON.stringify(receipt.pins.wasm.sha256)}){port.postMessage({type:'result',pass:false,error:'Invalid brokered core resources'});return;}
  const loaderUrl=URL.createObjectURL(new Blob([loader],{type:'text/javascript'})),abiUrl=URL.createObjectURL(new Blob([abi],{type:'text/javascript'}));
  const workerUrl=URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}],{type:'text/javascript'}));
  const worker=new Worker(workerUrl,{type:'module',name:'ecs-dolphin-host'});
  worker.onerror=event=>port.postMessage({type:'result',pass:false,error:event.message});
  worker.onmessage=event=>{
   const message=event.data;
   if(message.type==='frame'){
    canvas.width=message.width;canvas.height=message.height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(message.rgba),message.width,message.height),0,0);
   }
   if(message.type==='result'){
    const pixel=(x,y)=>[...canvas.getContext('2d').getImageData(x,y,1,1).data];
    const top=pixel(canvas.width>>1,canvas.height>>2),bottom=pixel(canvas.width>>1,(canvas.height*3)>>2);
    const colours=top[1]>180&&top[0]<60&&top[2]<60&&bottom[2]>180&&bottom[0]<60&&bottom[1]<60;
    port.postMessage({...message,pass:message.pass&&colours&&crossOriginIsolated,top,bottom,width:canvas.width,height:canvas.height,companionIsolated:crossOriginIsolated,workerBlob:workerUrl.startsWith('blob:'),loaderBlob:loaderUrl.startsWith('blob:')});
    worker.terminate();for(const url of [loaderUrl,abiUrl,workerUrl])URL.revokeObjectURL(url);
   }
  };
  worker.postMessage({loaderUrl,abiUrl,wasmBinary,dol},[wasmBinary,dol]);
 };port.start();port.postMessage({type:'connected'});
});parent.postMessage({type:'ready',nonce},expectedParent);
`;
  parentScript = `
const expectedOrigin=${JSON.stringify(companionOrigin)},nonce=${JSON.stringify(nonce)},frame=document.querySelector('iframe'),status=document.querySelector('pre');
const files=Promise.all(['loader.js','abi.mjs','core.wasm','original-video.dol'].map(async name=>{const response=await fetch('./'+name);if(!response.ok)throw Error(name);return response.arrayBuffer();}));
const channel=new MessageChannel();
channel.port1.onmessage=async event=>{
 if(event.data?.type==='connected'){
  const [loader,abi,wasmBinary,dol]=await files;
  const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(v=>v.toString(16).padStart(2,'0')).join('');
  if(await hash(loader)!==${JSON.stringify(receipt.changedLoaderSha256)}||await hash(wasmBinary)!==${JSON.stringify(receipt.pins.wasm.sha256)})throw Error('Verified core digest mismatch');
  channel.port1.postMessage({loader,abi,wasmBinary,dol},[loader,abi,wasmBinary,dol]);
 }
 if(event.data?.type==='result'){window.__dolphinResult={...event.data,topIsolated:crossOriginIsolated,userAgent:navigator.userAgent};status.textContent=JSON.stringify(window.__dolphinResult,null,2);}
};channel.port1.start();
addEventListener('message',event=>{if(event.source===frame.contentWindow&&event.origin===expectedOrigin&&event.data?.type==='ready'&&event.data.nonce===nonce)frame.contentWindow.postMessage({type:'connect',nonce},expectedOrigin,[channel.port2]);});
`;
  let browser;
  const errors = [],
    requests = [];
  try {
    browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
    const page = await browser.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('request', (request) =>
      requests.push({
        origin: new URL(request.url()).origin,
        method: request.method(),
        blob: request.url().startsWith('blob:'),
      }),
    );
    await page.goto(`${parentOrigin}/${nonce}/`);
    await page.waitForFunction(() => window.__dolphinResult, null, { timeout: 30000 });
    const result = await page.evaluate(() => window.__dolphinResult);
    result.pageErrors = errors;
    result.pass &&=
      errors.length === 0 &&
      result.topIsolated &&
      companionRequests.every((request) => request.path === 'bootstrap');
    Object.assign(result, {
      browser: browser.version(),
      programSha256: digest(program),
      pins: receipt.pins,
      changedLoaderSha256: receipt.changedLoaderSha256,
      companionRequests,
      parentRequests,
      networkOrigins: [
        ...new Set(requests.filter((request) => !request.blob).map((request) => request.origin)),
      ].map((origin) =>
        origin === parentOrigin
          ? 'parent'
          : origin === companionOrigin
            ? 'companion'
            : 'unexpected',
      ),
      sandbox:
        'Different-origin loopback companion only serves bootstrap; verified core/content transferred through one private MessagePort; connect-src blob:, worker-src blob:',
    });
    await page
      .frameLocator('iframe')
      .locator('canvas')
      .screenshot({ path: join(output, 'dolphin-browser.png') });
    await writeFile(
      join(output, 'dolphin-browser-result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return result;
  } finally {
    await browser?.close();
    await Promise.all([
      new Promise((done) => parent.close(done)),
      new Promise((done) => companion.close(done)),
    ]);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4)
    throw new Error(
      'Usage: node dolphin-browser-probe.mjs PINNED_EXTERNAL_FORK NEW_EXTERNAL_OUTPUT',
    );
  const result = await runDolphinBrowserProbe(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}
