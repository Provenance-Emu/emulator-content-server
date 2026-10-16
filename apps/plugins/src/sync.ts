import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { ContentError, type UploadRequest } from '@ecs/client';
import {
  classify,
  type KindRule,
  PluginError,
  planReplication,
  type RemoteObject,
  type ReplicationReport,
  type ReplicationStep,
  type StorageConnector,
  type SyncDirection,
} from '@ecs/plugins';

interface SyncClient {
  manifest(itemId: string): Promise<{
    revision: number;
    files: { id: string; kind: string; relativePath: string; sha256: string }[];
  }>;
  upload(request: UploadRequest): Promise<unknown>;
  collect(assetId: string): Promise<{ bytes: Uint8Array }>;
}

/**
 * Copies bytes between a connector and one item. The content server stays the
 * source of truth: this uses the manifest, the resumable upload, and ranged
 * reads, and it does not open the catalog or the blob directory.
 */
export async function syncItem(input: {
  client: SyncClient;
  connector: StorageConnector;
  libraryId: string;
  itemId: string;
  kinds: readonly KindRule[];
  direction: SyncDirection;
}): Promise<ReplicationReport> {
  const manifest = await input.client.manifest(input.itemId);
  const cached = new Map<string, Uint8Array>();
  const remote = await Promise.all(
    (await input.connector.list()).map(async (object) =>
      withDigest(input.connector, object, input.kinds, cached),
    ),
  );
  const steps = planReplication(
    remote,
    manifest.files.map((file) => ({
      id: file.id,
      relativePath: file.relativePath,
      sha256: file.sha256,
      kind: file.kind,
    })),
    {
      direction: input.direction,
      writable: input.connector.writable,
      itemRevision: manifest.revision,
    },
  );
  const report: ReplicationReport = { uploaded: [], downloaded: [], skipped: [], refused: [] };
  let revision = manifest.revision;
  for (const step of steps) {
    if (step.op === 'skip') {
      report.skipped.push(step.relativePath);
      continue;
    }
    if (step.op === 'refuse') {
      report.refused.push({ relativePath: step.relativePath, reason: step.reason });
      continue;
    }
    if (step.op === 'download') {
      await download(input, step, report);
      continue;
    }
    const outcome = await upload(input, step, cached, step.keepBoth ? 0 : revision);
    if (outcome === 'conflict' && !step.keepBoth) {
      revision = (await input.client.manifest(input.itemId)).revision;
      const retried = await upload(input, step, cached, revision);
      if (retried === 'ok') {
        revision += 1;
        report.uploaded.push(step.relativePath);
      } else {
        report.refused.push({ relativePath: step.relativePath, reason: 'strict-conflict' });
      }
      continue;
    }
    if (outcome === 'ok') {
      revision += 1;
      report.uploaded.push(step.relativePath);
      continue;
    }
    report.refused.push({ relativePath: step.relativePath, reason: 'strict-conflict' });
  }
  return report;
}

async function withDigest(
  connector: StorageConnector,
  object: RemoteObject,
  kinds: readonly KindRule[],
  cached: Map<string, Uint8Array>,
): Promise<RemoteObject> {
  const kind = classify(object.relativePath, kinds);
  if (object.sha256 !== null) return { ...object, kind };
  const bytes = await readAll(connector, object);
  cached.set(object.locator, bytes);
  return {
    ...object,
    kind,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function readAll(connector: StorageConnector, object: RemoteObject): Promise<Uint8Array> {
  if (object.size === 0) return new Uint8Array();
  const bytes = await connector.read(object, 0, object.size - 1);
  if (bytes.byteLength !== object.size) {
    throw new PluginError('bad-range', `${object.relativePath} came back shorter than its listing`);
  }
  return bytes;
}

async function upload(
  input: { client: SyncClient; connector: StorageConnector; libraryId: string; itemId: string },
  step: Extract<ReplicationStep, { op: 'upload' }>,
  cached: Map<string, Uint8Array>,
  baseRevision: number,
): Promise<'ok' | 'conflict'> {
  const bytes =
    cached.get(step.locator) ??
    (await readAll(input.connector, {
      relativePath: step.relativePath,
      locator: step.locator,
      size: step.size,
      sha256: step.sha256,
      kind: step.kind,
    }));
  try {
    await input.client.upload({
      libraryId: input.libraryId,
      itemId: input.itemId,
      kind: step.kind,
      displayName: posix.basename(step.relativePath),
      relativePath: step.relativePath,
      baseRevision,
      body: bytes,
      idempotencyKey: createHash('sha256')
        .update(`${step.relativePath}\0${step.sha256}\0${baseRevision}`)
        .digest('hex'),
      chunkBytes: 4 * 1024 * 1024,
    });
    return 'ok';
  } catch (error) {
    if (error instanceof ContentError && error.status === 409) return 'conflict';
    throw error;
  }
}

async function download(
  input: { client: SyncClient; connector: StorageConnector },
  step: Extract<ReplicationStep, { op: 'download' }>,
  report: ReplicationReport,
): Promise<void> {
  if (!input.connector.put) {
    report.refused.push({ relativePath: step.relativePath, reason: 'connector-read-only' });
    return;
  }
  const collected = await input.client.collect(step.assetId);
  await input.connector.put(step.relativePath, collected.bytes);
  report.downloaded.push(step.relativePath);
}
