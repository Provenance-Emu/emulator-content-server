import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { DomainError } from '@ecs/domain';
import { type ContentHash, hashFile } from './hash.js';
import { blobPath, stagingFile } from './paths.js';

export interface PlacedBlob extends ContentHash {
  path: string;
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createStagingFile(root: string, uploadId: string): Promise<string> {
  const filePath = stagingFile(root, uploadId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.alloc(0), { flag: 'wx' }).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  return filePath;
}

export async function writeAtOffset(
  filePath: string,
  offset: number,
  source: Readable,
  maxBytes: number,
): Promise<number> {
  const handle = await open(filePath, 'r+');
  let written = 0;
  let started = false;
  try {
    const current = await handle.stat();
    if (current.size < offset) {
      throw new DomainError('upload-gap', 409, 'Upload offset leaves a gap');
    }
    if (current.size > offset) await handle.truncate(offset);
    let position = offset;
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (position + buffer.length > maxBytes) {
        throw new DomainError('quota-exceeded', 413, 'Upload exceeds the configured byte quota');
      }
      started = true;
      await handle.write(buffer, 0, buffer.length, position);
      position += buffer.length;
      written += buffer.length;
    }
    await handle.sync();
  } catch (error) {
    if (started) await handle.truncate(offset).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  return written;
}

export async function truncateStaging(filePath: string, size: number): Promise<void> {
  await truncate(filePath, size);
}

export async function placeBlob(root: string, sourcePath: string): Promise<PlacedBlob> {
  const hashes = await hashFile(sourcePath);
  const destination = blobPath(root, hashes.sha256);
  await mkdir(dirname(destination), { recursive: true });
  try {
    const existing = await stat(destination);
    if (existing.size !== hashes.size) {
      throw new DomainError('corrupt-blob', 500, 'Stored blob size does not match its digest');
    }
    return { ...hashes, path: destination };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(destination), `.${hashes.sha256}.${randomUUID()}.partial`);
  await copyFile(sourcePath, temporary);
  const handle = await open(temporary, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  await syncDirectory(dirname(destination));
  return { ...hashes, path: destination };
}

export async function removeStaging(root: string, uploadId: string): Promise<void> {
  await rm(stagingFile(root, uploadId), { force: true });
}

export function openBlob(root: string, sha256: string): Readable {
  return createReadStream(blobPath(root, sha256), { highWaterMark: 1024 * 1024 });
}

export async function blobFileSize(root: string, sha256: string): Promise<number> {
  const info = await stat(blobPath(root, sha256));
  return info.size;
}
