#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const playwrightRequire = createRequire(
  require.resolve('@playwright/test/package.json', { paths: [resolve('apps/web')] }),
);
const { chromium } = playwrightRequire('playwright');
const BASE = 'https://web.libretro.com';
const LIMITS = { js: 8 * 1024 * 1024, wasm: 64 * 1024 * 1024 };
const PARALLELISM = 2;
const date = new Date().toISOString().slice(0, 10);
const cache = join(homedir(), '.cache', `ecs-wasm-inventory-${date}`);
const artifacts = join(cache, 'web-audit');
await mkdir(artifacts, { recursive: true });

async function fetchBytes(url, cap) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(advertised) && advertised > cap) {
    await response.body?.cancel();
    return {
      status: 'over-cap',
      bytes: advertised,
      sha256: null,
      lastModified: response.headers.get('last-modified'),
    };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > cap)
    return {
      status: 'over-cap',
      bytes: bytes.length,
      sha256: null,
      lastModified: response.headers.get('last-modified'),
    };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    status: 'downloaded',
    bytes: bytes.length,
    sha256,
    lastModified: response.headers.get('last-modified'),
    data: bytes,
  };
}

const selectorResponse = await fetch(`${BASE}/core_list.js`, {
  signal: AbortSignal.timeout(30_000),
});
if (!selectorResponse.ok)
  throw new Error(`Official selector returned HTTP ${selectorResponse.status}`);
const selector = Buffer.from(await selectorResponse.arrayBuffer());
await writeFile(join(cache, 'web_core_list.js'), selector);
const names = [...selector.toString('utf8').matchAll(/^\s*"([A-Za-z0-9_]+)"\s*:/gm)].map(
  (match) => match[1],
);
const cores = [...new Set(names)];
const records = [];
let cursor = 0;
async function fetchWorker() {
  while (cursor < cores.length) {
    const core = cores[cursor++];
    const record = { core, artifacts: {}, errors: [] };
    records.push(record);
    for (const ext of ['js', 'wasm']) {
      const url = `${BASE}/${core}_libretro.${ext}`;
      try {
        const result = await fetchBytes(url, LIMITS[ext]);
        record.artifacts[ext] = {
          url,
          status: result.status,
          bytes: result.bytes,
          sha256: result.sha256,
          lastModified: result.lastModified,
        };
        if (result.data) {
          await writeFile(join(artifacts, `${core}_libretro.${ext}`), result.data);
          delete result.data;
        }
      } catch (error) {
        record.errors.push(`${ext}: ${error.message}`);
      }
    }
    await writeFile(join(cache, 'web-audit-downloads.json'), JSON.stringify(records, null, 2));
  }
}
await Promise.all(Array.from({ length: PARALLELISM }, fetchWorker));

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, {
      'content-type': 'text/html',
      'content-security-policy':
        "default-src 'none'; script-src 'self' blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'self'; frame-src 'self'; worker-src 'none'",
    });
    response.end('<!doctype html><title>libretro factory audit</title>');
    return;
  }
  const file = basename(url.pathname);
  try {
    const bytes = await readFile(join(artifacts, file));
    response.writeHead(200, {
      'content-type': file.endsWith('.wasm') ? 'application/wasm' : 'application/javascript',
      'access-control-allow-origin': '*',
    });
    response.end(bytes);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader'],
});
const pairs = records.filter(
  (record) =>
    record.artifacts.js?.status === 'downloaded' && record.artifacts.wasm?.status === 'downloaded',
);
const smokeResults = [];
let smokeCursor = 0;
async function smoke(core) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    const result = await page.evaluate(
      async ({ core, port }) => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        document.body.append(frame);
        frame.addEventListener('load', () => frame.contentWindow.postMessage({ core, port }, '*'), {
          once: true,
        });
        frame.srcdoc =
          `<script>addEventListener('message', async (event) => {
        try {
          const core = event.data.core;
          const base = 'http://127.0.0.1:' + event.data.port + '/';
          const loader = await (await fetch(base + core + '_libretro.js')).text();
          const wasmBinary = await (await fetch(base + core + '_libretro.wasm')).arrayBuffer();
          const moduleUrl = URL.createObjectURL(new Blob([loader], { type: 'text/javascript' }));
          const imported = await import(moduleUrl);
          if (typeof imported.default !== 'function') throw new Error('default factory missing');
          const module = await imported.default({
            wasmBinary,
            noInitialRun: true,
            noExitRuntime: true,
            canvas: null,
            locateFile: (path) => path.endsWith('.wasm') ? base + core + '_libretro.wasm' : (() => { throw new Error('unexpected file ' + path); })(),
          });
          const fs = module.FS;
          if (!fs || ['mkdirTree', 'writeFile', 'readFile'].some((name) => typeof fs[name] !== 'function') || typeof module.callMain !== 'function') throw new Error('required MEMFS/callMain exports missing');
          fs.mkdirTree('/audit');
          fs.writeFile('/audit/probe', new Uint8Array([42]));
          if (fs.readFile('/audit/probe')[0] !== 42) throw new Error('MEMFS round-trip failed');
          parent.postMessage({ ok: true, origin: location.origin }, '*');
        } catch (error) { parent.postMessage({ ok: false, error: String(error.stack || error) }, '*'); }
      });</scr` + `ipt>`;
        return await new Promise((resolveResult) => {
          const timer = setTimeout(
            () => resolveResult({ ok: false, error: 'startup timeout' }),
            15_000,
          );
          addEventListener('message', function onMessage(event) {
            if (event.source !== frame.contentWindow) return;
            clearTimeout(timer);
            removeEventListener('message', onMessage);
            resolveResult(event.data);
          });
        });
      },
      { core, port },
    );
    return { core, ...result, pageErrors };
  } catch (error) {
    return { core, ok: false, error: error.message, pageErrors };
  } finally {
    await page.close();
  }
}
async function smokeWorker() {
  while (smokeCursor < pairs.length) {
    const record = pairs[smokeCursor++];
    smokeResults.push(await smoke(record.core));
    await writeFile(join(cache, 'web-audit-smokes.json'), JSON.stringify(smokeResults, null, 2));
  }
}
try {
  await Promise.all(Array.from({ length: PARALLELISM }, smokeWorker));
} finally {
  await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
console.log(
  JSON.stringify(
    {
      selectorNames: cores.length,
      downloadedUnderCapPairs: pairs.length,
      passed: smokeResults.filter((result) => result.ok).length,
      failed: smokeResults.filter((result) => !result.ok),
      cacheDirectory: cache,
    },
    null,
    2,
  ),
);
