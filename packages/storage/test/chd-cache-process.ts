// A separate Node process exercises real filesystem lock arbitration without a
// platform-native decoder or process-local singleflight state shared by callers.
import { once } from 'node:events';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createChdProvider } from '../src/chd-decoder.js';
import { VirtualProviderRegistry } from '../src/virtual.js';
import { openVirtualEntry } from '../src/virtual-cache.js';
import { probeRunner, QUOTA } from './chd-fixture.js';

const root = process.argv[2];
const sha256 = process.argv[3];
if (!root || !sha256) throw new Error('Missing generated test input');
const cue =
  'FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:00:01\n';
const provider = await createChdProvider(join(root, 'decoder'), {
  runner(executable, args, options) {
    const child = probeRunner(executable, args, options);
    if (args[0] === 'help') return child;
    process.send?.({ kind: 'decode' });
    return {
      ...child,
      exited: (async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await writeFile(join(options.cwd, 'disc.bin'), Buffer.alloc(4400, 37));
        await writeFile(join(options.cwd, 'tool.cue'), cue);
        return { code: 0 };
      })(),
    };
  },
});
const registry = new VirtualProviderRegistry([provider], { ...QUOTA, timeoutMs: 10_000 });
process.send?.({ kind: 'ready' });
await once(process, 'message');
try {
  const opened = await openVirtualEntry(root, sha256, registry, '1');
  if (!opened) throw new Error('CHD artifact is missing');
  process.send?.({ kind: 'result', path: opened.path, ino: (await stat(opened.path)).ino });
} catch (error) {
  process.send?.({ kind: 'error', error: String(error) });
  process.exitCode = 1;
} finally {
  await registry.close();
  process.disconnect();
}
