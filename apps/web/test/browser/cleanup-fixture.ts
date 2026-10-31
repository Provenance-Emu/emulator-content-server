import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { ContentClient } from '@ecs/client';
import { installBundledCleanup } from '../../../plugins/dist/src/workflows/bundled.js';
import { startWorkflowHost } from '../../../plugins/dist/src/workflows/transport.js';

function image() {
  const chunk = (type: string, bytes: Buffer) => {
    const name = Buffer.from(type),
      out = Buffer.alloc(bytes.length + 12);
    out.writeUInt32BE(bytes.length);
    name.copy(out, 4);
    bytes.copy(out, 8);
    out.writeUInt32BE(crc32(Buffer.concat([name, bytes])), out.length - 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk(
      'IDAT',
      deflateSync(
        Buffer.from([
          0, 255, 140, 40, 255, 255, 140, 40, 255, 0, 255, 140, 40, 255, 255, 140, 40, 255,
        ]),
      ),
    ),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
export async function cleanupFixture(
  client: ContentClient,
  origin: string,
  directory: string,
  libraryId: string,
) {
  const folder = join(directory, 'cleanup-games');
  await mkdir(folder);
  for (const name of ['First', 'Second']) {
    await writeFile(join(folder, `${name}.j64`), Buffer.from([1, 2, 3, 4]));
    await writeFile(
      join(folder, `${name}.json`),
      JSON.stringify({ title: `Restored ${name}`, publisher: 'Homebrew' }),
    );
    await writeFile(join(folder, `${name}.png`), image());
  }
  const root = await client.addRoot({ path: folder, label: 'Cleanup games', libraryId });
  await client.scanRoot(root.id);
  const stateDirectory = join(directory, 'private-host');
  const installed = await installBundledCleanup(stateDirectory);
  const enrollment = await client.createWorkflowHost('Native cleanup host');
  const worker = await client.enrollWorkflowHost(enrollment.enrollmentToken);
  const workerClient = new ContentClient(origin, worker.token),
    abort = new AbortController();
  const running = startWorkflowHost(
    { stateDirectory, server: origin, client: workerClient },
    abort.signal,
  ).catch((error) => {
    if (!abort.signal.aborted) throw error;
  });
  return {
    root,
    installed,
    async stop() {
      abort.abort();
      await running;
    },
  };
}
