import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { issueToken } from '@ecs/auth';
import { libraryFixture } from './library-fixture.js';

export function generatedPng(width = 2, height = 2): Buffer {
  function chunk(type: string, bytes: Buffer) {
    const name = Buffer.from(type);
    const result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length, 0);
    name.copy(result, 4);
    bytes.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([name, bytes])), result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function workflowFixture(options: { count?: number } = {}) {
  const f = await libraryFixture();
  const path = join(f.base, 'cleanup-games');
  await mkdir(path);
  const png = generatedPng();
  const names = Array.from({ length: options.count ?? 1 }, (_, index) =>
    (options.count ?? 1) === 1 ? 'Game' : `Game-${index + 1}`,
  );
  for (const name of names) {
    await writeFile(join(path, `${name}.j64`), Buffer.from([1, 2, 3, 4]));
    await writeFile(
      join(path, `${name}.json`),
      JSON.stringify({ title: `Generated ${name}`, publisher: 'Homebrew' }),
    );
    await writeFile(join(path, `${name}.png`), png);
  }
  const root = f.catalog.createContentRoot({
    path,
    label: 'Cleanup games',
    libraryId: f.library.id,
    actorId: f.owner.id,
  });
  await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
  const sources = f.catalog.listSources(root.id).filter((s) => s.kind === 'rom');
  const source = sources.find((s) => s.displayName === `${names[0]}.j64`);
  if (!source) throw new Error('Missing generated source');
  const enrollment = issueToken(),
    worker = issueToken();
  const host = f.catalog.workflowIdentities.createHost(
    f.owner.id,
    'Cleanup host',
    enrollment.hash,
    Date.now() + 600_000,
  );
  f.catalog.workflowIdentities.enrollHost(enrollment.hash, worker.hash);
  const run = f.catalog.workflowRuns.createRun(
    {
      workflowId: 'org.ecs.library-cleanup',
      workflowDigest: 'a'.repeat(64),
      hostId: host.id,
      scope: { libraryId: f.library.id },
      options: { online: false, checksum: false, shareImages: false },
    },
    f.owner.id,
  );
  const lease = f.catalog.workflowRuns.claimRun(host.id);
  if (!lease) throw new Error('Missing lease');
  const workerHeaders = { authorization: `Bearer ${worker.token}` };
  const baseUrl = `/api/v1/workflow-workers/runs/${run.id}`;
  const result = await f.app.inject({
    method: 'POST',
    url: `${baseUrl}/sources/${source.id}/catalog`,
    headers: workerHeaders,
    payload: {},
  });
  if (result.statusCode !== 200) throw new Error(result.body);
  return {
    ...f,
    path,
    png,
    root,
    source,
    sources,
    run,
    lease,
    workerHeaders,
    baseUrl,
    inspection: result.json(),
  };
}
