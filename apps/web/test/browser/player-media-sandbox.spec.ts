import { resolve } from 'node:path';
import { build } from 'vite';
import { expect, test } from './fixture';

test('disc staging enforces one aggregate budget while allowing safe overwrites inside the opaque runtime', async ({
  page,
  fixture,
}) => {
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
  if (!output || !('output' in output)) throw Error('Missing runtime harness');
  const entry = output.output.find((chunk) => chunk.type === 'chunk' && chunk.isEntry);
  if (entry?.type !== 'chunk') throw Error('Missing runtime entry');
  await page.route('**/ui/player-media-harness.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: entry.code }),
  );
  await page.goto(`${fixture.origin}/play/`);
  const result = await page.evaluate(async () => {
    const api = await import('/ui/player-media-harness.js');
    const loader = new TextEncoder().encode(
      'export default async()=>{const files=new Map();return{FS:{mkdirTree(){},writeFile(p,b){files.set(p,b);},readFile(p){return files.get(p);}},callMain(){}}}',
    );
    const loaded = await api.importBrowserRuntime(loader, {
      profile: { maxContentBytes: 6, saveCompletion: 'none' },
      assets: [],
    });
    const runtime = await loaded.factory({
      wasmBinary: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      canvas: document.querySelector('canvas'),
      noInitialRun: true,
      noExitRuntime: true,
      locateFile: (s) => s,
      print() {},
      printErr() {},
    });
    await runtime.FS.writeFile('/ecs/content/track-000.bin', new Uint8Array([1, 2, 3, 4]));
    await runtime.FS.writeFile('/ecs/content/game.cue', new Uint8Array([5, 6]));
    let rejected = false;
    try {
      await runtime.FS.writeFile('/ecs/content/track-001.bin', new Uint8Array([7]));
    } catch {
      rejected = true;
    }
    await runtime.FS.writeFile('/ecs/content/track-000.bin', new Uint8Array([8]));
    await runtime.FS.writeFile('/ecs/content/track-001.bin', new Uint8Array([9, 10, 11]));
    const read = await runtime.FS.readFile('/ecs/content/track-001.bin');
    loaded.release();
    return { rejected, read: [...read] };
  });
  expect(result).toEqual({ rejected: true, read: [9, 10, 11] });
});
