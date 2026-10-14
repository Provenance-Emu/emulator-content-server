import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LOG_LIMIT_BYTES = 1024 * 1024;
export const LOG_KEEP = 5;

export interface LogLimits {
  limit: number;
  keep: number;
}

/**
 * A daemon log must not keep a credential that a request line happened to
 * carry. The content server already redacts its own logger; this is the file
 * those lines land in when there is no terminal.
 */
export function redactLogText(text: string): string {
  return text
    .replace(/bootstrap token:\s*\S+/gi, 'Bootstrap token: [redacted]')
    .replace(/(authorization\s*:\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:password|token|bootstrap)[=:]\s*)\S+/gi, '$1[redacted]');
}

export async function appendRotatingLog(
  directory: string,
  text: string,
  limits: LogLimits = { limit: LOG_LIMIT_BYTES, keep: LOG_KEEP },
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const live = join(directory, 'ecs.log');
  const safe = redactLogText(text);
  const current = await stat(live).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
  if (current && current.size > 0 && current.size + Buffer.byteLength(safe) > limits.limit) {
    await shiftLogs(directory, limits.keep);
  }
  await writeFile(live, safe, { flag: 'a' });
}

/**
 * The live file is renamed aside and created again. Only an archived generation
 * past the keep count is removed, so the file currently being written is never
 * the one that gets deleted.
 */
async function shiftLogs(directory: string, keep: number): Promise<void> {
  const live = join(directory, 'ecs.log');
  await rm(join(directory, `ecs.log.${keep}`), { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    const from = join(directory, `ecs.log.${index}`);
    const to = join(directory, `ecs.log.${index + 1}`);
    await rename(from, to).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  await rename(live, join(directory, 'ecs.log.1'));
  await writeFile(live, '');
}

export async function captureDaemonLogs(dataDir: string): Promise<{ close: () => Promise<void> }> {
  const directory = join(dataDir, 'logs');
  await mkdir(directory, { recursive: true });
  let pending = Promise.resolve();
  const wrap = (stream: NodeJS.WriteStream) => {
    const original = stream.write;
    const write = original as (
      chunk: string,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => boolean;
    stream.write = ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      const safe = redactLogText(text);
      pending = pending.then(() => appendRotatingLog(directory, safe)).catch(() => undefined);
      if (typeof encoding === 'function') return write.call(stream, safe, encoding);
      return write.call(stream, safe, encoding, callback);
    }) as typeof stream.write;
    return () => {
      stream.write = original;
    };
  };
  const restoreOut = wrap(process.stdout);
  const restoreErr = wrap(process.stderr);
  return {
    close: async () => {
      await pending;
      restoreOut();
      restoreErr();
    },
  };
}
