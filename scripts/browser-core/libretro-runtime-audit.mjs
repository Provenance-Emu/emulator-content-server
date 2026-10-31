/** Startup-only smoke using the unchanged production opaque sandbox and CSP. */
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(join(repository, 'apps/web/package.json'));
const { chromium } = require('@playwright/test');
export async function smokeLibretroPairs(pairs, output) {
  const sandbox = await readFile(join(repository, 'apps/web/public/play/sandbox.html'));
  const sandboxCsp = [
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
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    if (path === '/') {
      response.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy':
          "default-src 'none'; script-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'",
      });
      response.end('<!doctype html><title>Opaque core audit</title>');
      return;
    }
    if (path === '/sandbox.html') {
      response.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': sandboxCsp,
        'cross-origin-embedder-policy': 'require-corp',
        'cross-origin-resource-policy': 'cross-origin',
        'referrer-policy': 'no-referrer',
      });
      response.end(sandbox);
      return;
    }
    const match = /^\/([A-Za-z0-9_]+_libretro\.(js|wasm))$/.exec(path);
    if (match && pairs.some(({ core }) => match[1] === `${core}_libretro.${match[2]}`)) {
      try {
        const bytes = await readFile(
          pairs.find(({ core }) => match[1].startsWith(`${core}_libretro.`))[
            match[2] === 'js' ? 'loaderPath' : 'wasmPath'
          ],
        );
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(bytes);
        return;
      } catch {
        /* unavailable artifact */
      }
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;

  const results = [];
  let smokeCursor = 0;
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--mute-audio', '--use-gl=angle', '--use-angle=swiftshader'],
    });
    async function smokeWorker() {
      while (smokeCursor < pairs.length) {
        const { core, originalNesPath } = pairs[smokeCursor++],
          page = await browser.newPage(),
          pageErrors = [],
          unexpectedRequests = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        await page.route('**/*', (route) => {
          const url = route.request().url();
          if (url.startsWith(`${base}/`)) return route.continue();
          unexpectedRequests.push(url.split('?')[0]);
          return route.abort();
        });
        try {
          await page.goto(base);
          const nonce = randomBytes(16).toString('hex');
          const originalNes = originalNesPath ? [...(await readFile(originalNesPath))] : null;
          const result = await page.evaluate(
            async ({ core, nonce, originalNes }) => {
              const loader = await (await fetch(`/${core}_libretro.js`)).arrayBuffer();
              const wasm = await (await fetch(`/${core}_libretro.wasm`)).arrayBuffer();
              const frame = document.createElement('iframe');
              frame.sandbox = 'allow-scripts';
              let rpcId = 0,
                port,
                readyOrigin;
              const pending = new Map();
              const connected = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(Error('startup timeout')), 20000);
                addEventListener('message', function onMessage(event) {
                  if (
                    event.source !== frame.contentWindow ||
                    event.data?.type !== 'ecs-player-ready' ||
                    event.data.nonce !== nonce
                  )
                    return;
                  removeEventListener('message', onMessage);
                  readyOrigin = event.origin;
                  const channel = new MessageChannel();
                  port = channel.port1;
                  port.onmessage = (message) => {
                    if (message.data.type === 'connected') {
                      clearTimeout(timeout);
                      resolve();
                    }
                    if (message.data.type === 'result') {
                      const done = pending.get(message.data.id);
                      pending.delete(message.data.id);
                      if (done)
                        message.data.error
                          ? done.reject(Error(message.data.error))
                          : done.resolve(message.data.value);
                    }
                  };
                  port.start();
                  frame.contentWindow.postMessage({ type: 'ecs-player-connect', nonce }, '*', [
                    channel.port2,
                  ]);
                });
              });
              frame.src = `/sandbox.html#${nonce}`;
              document.body.append(frame);
              await connected;
              const rpc = (op, value, transfers = []) =>
                new Promise((resolve, reject) => {
                  const id = ++rpcId;
                  pending.set(id, { resolve, reject });
                  port.postMessage({ id, op, value }, transfers);
                });
              const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(Error('factory timeout')), 20000),
              );
              let pixel = null;
              try {
                await Promise.race([
                  timeout,
                  (async () => {
                    await rpc(
                      'init',
                      {
                        loader,
                        wasm,
                        assets: [],
                        commands: false,
                        shaders: { scanlines: '', lcd: '' },
                      },
                      [loader, wasm],
                    );
                    await rpc('mkdir', '/ecs/audit');
                    const bytes = new Uint8Array([42, 7]).buffer;
                    await rpc('write', { path: '/ecs/audit/probe', bytes }, [bytes]);
                    const result = new Uint8Array(await rpc('read', '/ecs/audit/probe'));
                    if (result[0] !== 42 || result[1] !== 7 || result.length !== 2)
                      throw Error('MEMFS round-trip failed');
                    if (originalNes) {
                      for (const directory of ['content', 'system', 'saves', 'states'])
                        await rpc('mkdir', `/ecs/${directory}`);
                      const write = async (path, bytes) => {
                        const buffer = new Uint8Array(bytes).buffer;
                        await rpc('write', { path, bytes: buffer }, [buffer]);
                      };
                      await write('/ecs/content/original.nes', originalNes);
                      await write(
                        '/ecs/retroarch.cfg',
                        new TextEncoder().encode(
                          'audio_enable = "false"\nvideo_driver = "gl"\nvideo_shader_enable = "false"\nmenu_driver = "null"\nsystem_directory = "/ecs/system"\nsavefile_directory = "/ecs/saves"\nsavestate_directory = "/ecs/states"\nconfig_save_on_exit = "false"\n',
                        ),
                      );
                      await rpc('main', [
                        '-v',
                        '--config',
                        '/ecs/retroarch.cfg',
                        '/ecs/content/original.nes',
                      ]);
                      const deadline = performance.now() + 10000;
                      while (!(await rpc('display-info')).captureReady) {
                        if (performance.now() > deadline)
                          throw Error('Original NES program did not render');
                        await new Promise((done) => setTimeout(done, 100));
                      }
                      do {
                        const shot = await rpc('screenshot');
                        const image = await createImageBitmap(
                          new Blob([shot], { type: 'image/png' }),
                        );
                        const canvas = document.createElement('canvas');
                        canvas.width = image.width;
                        canvas.height = image.height;
                        const context = canvas.getContext('2d');
                        context.drawImage(image, 0, 0);
                        image.close();
                        pixel = [
                          ...context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data,
                        ];
                        if (
                          pixel[2] >= pixel[0] + 30 &&
                          pixel[2] >= pixel[1] + 30 &&
                          pixel[3] === 255
                        )
                          break;
                        if (performance.now() > deadline)
                          throw Error(`Original NES blue palette output missing: ${pixel}`);
                        await new Promise((done) => setTimeout(done, 100));
                      } while (
                        pixel[2] < pixel[0] + 30 ||
                        pixel[2] < pixel[1] + 30 ||
                        pixel[3] !== 255
                      );
                    }
                  })(),
                ]);
                return {
                  ok: readyOrigin === 'null',
                  origin: readyOrigin,
                  productionSandbox: true,
                  acceptance: originalNes ? 'original-nes-video' : 'factory-memfs-only',
                  pixel,
                };
              } finally {
                port.close();
                frame.remove();
              }
            },
            { core, nonce, originalNes },
          );
          results.push({ core, ...result, pageErrors, unexpectedRequests });
        } catch (error) {
          results.push({ core, ok: false, error: error.message, pageErrors, unexpectedRequests });
        } finally {
          await page.close();
        }
        await writeFile(join(output, 'smokes.json'), JSON.stringify(results, null, 2));
      }
    }
    await Promise.all([smokeWorker(), smokeWorker()]);
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
  return { results, sandboxSha256: createHash('sha256').update(sandbox).digest('hex') };
}
