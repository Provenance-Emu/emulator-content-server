import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { MaterializeQuota, VirtualContentProvider } from '@ecs/domain';
import * as storage from '../src/index.js';

export const QUOTA: MaterializeQuota = {
  maxExpandedBytes: 1_000_000,
  maxCompressionRatio: 10_000,
  maxEntries: 100,
  maxNesting: 2,
  timeoutMs: 2_000,
};
export interface ProcessHandle {
  stdout: PassThrough;
  stderr: PassThrough;
  exited: Promise<{ code: number | null; signal?: string | null }>;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}
export type Runner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; shell: false; stdio: readonly string[]; windowsHide: boolean },
) => ProcessHandle;
export type Factory = (
  executable: string,
  options?: { runner?: Runner; pollIntervalMs?: number; killGraceMs?: number },
) => Promise<VirtualContentProvider & { close?(): Promise<void> }>;
export const factory = async (): Promise<Factory> => {
  assert.equal(
    typeof (storage as Record<string, unknown>).createChdProvider,
    'function',
    'storage must export the validated CHD factory',
  );
  return (storage as unknown as { createChdProvider: Factory }).createChdProvider;
};
export const probeRunner: Runner = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.end('extractcd extractdvd -i -o -ob');
  stderr.end();
  return { stdout, stderr, exited: Promise.resolve({ code: 0 }), kill() {} };
};
export function synthetic(tags: [string, string][] = [['DVD ', '']], dvd = true): Buffer {
  const header = Buffer.alloc(124);
  header.write('MComprHD');
  header.writeUInt32BE(124, 8);
  header.writeUInt32BE(5, 12);
  header.writeBigUInt64BE(
    BigInt(
      dvd
        ? 4096
        : Math.min(
            1_000_000_000,
            tags
              .filter(([tag]) => tag === 'CHT2')
              .reduce(
                (sum, [, text]) =>
                  sum + Math.ceil(Number(/FRAMES:(\d+)/.exec(text)?.[1] ?? 0) / 4) * 4 * 2448,
                0,
              ),
          ),
    ),
    32,
  );
  header.writeBigUInt64BE(124n, 40);
  header.writeBigUInt64BE(tags.length ? 140n : 0n, 48);
  header.writeUInt32BE(dvd ? 4096 : 9792, 56);
  header.writeUInt32BE(dvd ? 2048 : 2448, 60);
  const parts: Buffer[] = [header, Buffer.alloc(16)];
  let offset = 140;
  for (const [index, [tag, text]] of tags.entries()) {
    const body = Buffer.from(`${text}\0`);
    const meta = Buffer.alloc(16);
    meta.write(tag);
    meta.writeUIntBE(body.length, 5, 3);
    offset += 16 + body.length;
    meta.writeBigUInt64BE(index + 1 < tags.length ? BigInt(offset) : 0n, 8);
    parts.push(meta, body);
  }
  return Buffer.concat(parts);
}
export const track = (number: number, mode: string, frames: number): [string, string] => [
  'CHT2',
  `TRACK:${number} TYPE:${mode} SUBTYPE:NONE FRAMES:${frames} PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0`,
];
export async function fixture(
  bytes: Buffer,
  runner: Runner = probeRunner,
  options: { pollIntervalMs?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'ecs-chd-'));
  const executable = join(root, 'decoder');
  const path = join(root, 'source');
  await writeFile(executable, '', { mode: 0o700 });
  await writeFile(path, bytes);
  const provider = await (await factory())(executable, {
    runner,
    pollIntervalMs: 5,
    killGraceMs: 10,
    ...options,
  });
  return {
    root,
    path,
    provider,
    async cleanup() {
      await provider.close?.();
      await rm(root, { recursive: true, force: true });
    },
  };
}
