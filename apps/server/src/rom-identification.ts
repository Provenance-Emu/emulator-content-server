import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DomainError } from '@ecs/domain';
import { matchingJob } from '@ecs/plugins/matching-host';
import { type RomFacts, validateRomFacts } from '@ecs/plugins/rom-facts';
import type { ServerContext } from './context.js';
import { sourceMetadata } from './source-metadata.js';

const ZIP_IDENTIFIER = fileURLToPath(new URL('./zip-identification-plugin.js', import.meta.url));
const tools = new WeakMap<ServerContext, Promise<{ sevenZip?: string; chdman?: string }>>();
const versions = new WeakMap<ServerContext, Promise<string>>();
async function discover(
  configured: string | undefined,
  names: string[],
): Promise<string | undefined> {
  const candidates = configured
    ? [configured]
    : [
        ...(process.env.PATH ?? '').split(delimiter),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        ...(process.platform === 'win32'
          ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', '7-Zip')]
          : []),
      ].flatMap((directory) => names.map((name) => join(directory, name)));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const path = await realpath(candidate);
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch {
      /* Optional operator-owned adapter. */
    }
  }
  if (configured)
    throw new DomainError(
      'matching-reader-unavailable',
      503,
      'Configured ROM identification reader is unavailable',
    );
  return undefined;
}
async function readerTools(context: ServerContext) {
  let pending = tools.get(context);
  if (!pending) {
    pending = (async () => {
      const [sevenZip, chdman] = await Promise.all([
        discover(
          context.matchingTools?.sevenZip ?? process.env.ECS_7ZIP_PATH,
          process.platform === 'win32' ? ['7z.exe', '7zz.exe'] : ['7zz', '7z'],
        ),
        discover(
          context.matchingTools?.chdman ?? process.env.ECS_CHDMAN_PATH,
          process.platform === 'win32' ? ['chdman.exe'] : ['chdman'],
        ),
      ]);
      return { ...(sevenZip ? { sevenZip } : {}), ...(chdman ? { chdman } : {}) };
    })();
    tools.set(context, pending);
  }
  return pending;
}
async function pluginVersion(context: ServerContext): Promise<string> {
  let pending = versions.get(context);
  if (!pending) {
    pending = (async () => {
      const digest = createHash('sha256').update('rom-identification-v3');
      const selected = await readerTools(context);
      for (const [name, path] of Object.entries(selected)) {
        const info = await stat(path, { bigint: true });
        digest.update(`${name}:${path}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`);
      }
      if (context.matchingPluginsDir) {
        const entries = await readdir(context.matchingPluginsDir, { withFileTypes: true });
        for (const entry of entries
          .filter((entry) => entry.isDirectory())
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 64)) {
          const path = join(context.matchingPluginsDir, entry.name, 'plugin.json');
          try {
            if ((await stat(path)).size > 65536) continue;
            const manifest = await readFile(path, 'utf8');
            digest.update(entry.name).update(manifest);
            const data = JSON.parse(manifest) as { entry?: unknown };
            if (
              typeof data.entry === 'string' &&
              !data.entry.includes('..') &&
              !isAbsolute(data.entry)
            ) {
              const info = await stat(join(context.matchingPluginsDir, entry.name, data.entry), {
                bigint: true,
              });
              digest.update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`);
            }
          } catch {
            /* Registry validation reports invalid plugins separately. */
          }
        }
      }
      return digest.digest('hex');
    })();
    versions.set(context, pending);
  }
  return pending;
}
/** Source containment and availability are checked by the caller; facts never expose the path to online providers. */
export async function identifySource(
  context: ServerContext,
  source: { id: string; displayName: string; systemId: string | null },
  path: string,
  signal: AbortSignal,
): Promise<RomFacts> {
  signal.throwIfAborted();
  const before = await sourceMetadata(path, source.id);
  const stamp = `${await pluginVersion(context)}:${before.etag}`;
  const cached = context.catalog.matchingIdentification(source.id, stamp);
  if (cached) {
    try {
      return validateRomFacts(cached);
    } catch {
      /* Invalid cache cannot supply evidence. */
    }
  }
  const reply = await matchingJob(
    {
      operation: 'identify',
      identifierModules: [ZIP_IDENTIFIER],
      identification: {
        path,
        name: source.displayName,
        systemId: source.systemId,
        size: before.size,
        tools: await readerTools(context),
      },
      ...(context.matchingPluginsDir ? { directory: context.matchingPluginsDir } : {}),
      catalogCacheDirectory: join(context.dataDir, 'cache', 'matching-catalogs'),
    },
    { signal, timeoutMs: 20000 },
  );
  const facts = validateRomFacts(reply.facts);
  if ((await sourceMetadata(path, source.id)).etag !== before.etag)
    throw new DomainError(
      'matching-source-changed',
      409,
      'Source changed while identifying it; scan and try again',
    );
  signal.throwIfAborted();
  context.catalog.saveMatchingIdentification(source.id, stamp, facts);
  return facts;
}
