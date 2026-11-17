import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import { DomainError, type SourceFileRecord } from '@ecs/domain';
import { assertSafeRelativePath } from '@ecs/protocol';
import { inspectRoot, resolveInside } from '@ecs/storage';
import { BlobReader, ZipReader } from '@zip.js/zip.js/index-native.js';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './context.js';
import { jsonObject, requireOwner } from './http.js';
import { discover } from './rom-identification.js';
import { reserveContentRoots } from './root-mutations.js';

const run = promisify(execFile);
const descriptor = /\.(cue|gdi)$/i;
const archive = /\.zip$/i;
const track = /\.(bin|raw|iso|wav)$/i;
const inputLimit = 4 * 1024 ** 3;
const cdSystems = new Set([
  'dreamcast',
  'psx',
  'segacd',
  'saturn',
  'pcecd',
  'pcfx',
  '3do',
  'neogeocd',
  'jaguarcd',
  'cdi',
]);
const active = new WeakMap<ServerContext, Promise<unknown>>();
type Policy = { enabled: boolean; keepOriginals: boolean };

function rejected(message: string): DomainError {
  return new DomainError('disc-conversion-rejected', 422, message);
}

async function policy(context: ServerContext, rootId: string): Promise<Policy> {
  try {
    return JSON.parse(
      await readFile(join(context.dataDir, 'disc-conversion', `${rootId}.json`), 'utf8'),
    ) as Policy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { enabled: false, keepOriginals: false };
  }
}

async function unpackZip(file: string, directory: string, signal: AbortSignal) {
  const reader = new ZipReader(new BlobReader(await openAsBlob(file)), {
    useWebWorkers: false,
    strictness: 'strict',
    checkSignature: true,
  });
  try {
    const entries = [];
    const names = new Set<string>();
    let size = 0;
    for await (const entry of reader.getEntriesGenerator()) {
      signal.throwIfAborted();
      if (entry.directory) continue;
      const name = entry.filename;
      if (
        entries.length >= 128 ||
        entry.encrypted ||
        entry.symlink ||
        !Number.isSafeInteger(entry.uncompressedSize) ||
        entry.uncompressedSize <= 0 ||
        (!descriptor.test(name) && !track.test(name))
      )
        throw rejected('The ZIP must contain one complete CD image and its tracks.');
      try {
        if (
          assertSafeRelativePath(name) !== name ||
          name.split('/').some((part) => part.startsWith('.')) ||
          /[:*?"<>|]/.test(name)
        )
          throw new Error('Unsafe filename');
      } catch {
        throw rejected('The ZIP contains an unsafe filename.');
      }
      if (names.has(name.toLowerCase())) throw rejected('The ZIP contains duplicate filenames.');
      names.add(name.toLowerCase());
      size += entry.uncompressedSize;
      if (size > inputLimit) throw rejected('The expanded disc exceeds the conversion size limit.');
      entries.push(entry);
    }
    const [description, extra] = entries.filter((entry) => descriptor.test(entry.filename));
    if (!description || extra) throw rejected('The ZIP must contain exactly one CUE or GDI.');
    for (const entry of entries) {
      const dest = join(directory, entry.filename);
      await mkdir(dirname(dest), { recursive: true });
      let written = 0;
      const bounded = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          written += chunk.byteLength;
          if (written > entry.uncompressedSize)
            throw rejected('A ZIP entry exceeded its declared size.');
          controller.enqueue(chunk);
        },
      });
      await Promise.all([
        entry.getData(bounded.writable, { signal, checkSignature: true }),
        bounded.readable.pipeTo(Writable.toWeb(createWriteStream(dest, { flags: 'wx' })), {
          signal,
        }),
      ]);
      if (written !== entry.uncompressedSize)
        throw rejected('A ZIP entry did not match its declared size.');
    }
    return description.filename;
  } finally {
    await reader.close();
  }
}

async function snapshot(context: ServerContext, root: string, file: SourceFileRecord) {
  const indexed = context.catalog.sourceInspectionIdentity(file.id);
  const path = await resolveInside(root, file.relativePath, { pinnedRoot: true });
  const stat = await lstat(path, { bigint: true });
  if (
    !stat.isFile() ||
    path !== resolve(root, file.relativePath) ||
    (await realpath(path)) !== path ||
    Number(stat.size) !== file.size ||
    (indexed?.filesystemIdentity &&
      indexed.filesystemIdentity !== `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`) ||
    (indexed?.mtimeMs != null && indexed.mtimeMs !== Number(stat.mtimeNs) / 1e6)
  )
    throw rejected('A disc file changed. Check the folder and try again.');
  return { path, stat };
}

async function convert(
  context: ServerContext,
  id: string,
  actorId: string,
  keepOriginals: boolean,
  signal: AbortSignal,
) {
  const { catalog } = context;
  const source = catalog.getSource(id);
  const root = source && catalog.getContentRoot(source.rootId);
  if (!source || !root) throw new DomainError('not-found', 404, 'Disc source not found');
  const release = reserveContentRoots(catalog, [root.id]);
  try {
    if (
      source.kind !== 'rom' ||
      source.availability !== 'local' ||
      source.groupAnchor ||
      source.groupError ||
      !source.systemId ||
      (!descriptor.test(source.relativePath) && !archive.test(source.relativePath))
    )
      throw rejected('Choose a complete local disc or ZIP.');
    const wrapped = archive.test(source.relativePath);
    const indexed = catalog.listSources(root.id);
    const group = source.groupMembers?.length ? catalog.sourceGroup(source.id) : [source];
    const members = new Set(group.map((file) => file.relativePath));
    if (
      (wrapped && group.length !== 1) ||
      (!wrapped && group.length < 2) ||
      (source.groupMembers?.length && group.length !== source.groupMembers.length) ||
      group.some(
        (file) =>
          file.availability !== 'local' || (file.id !== id && !track.test(file.relativePath)),
      ) ||
      indexed.some(
        (file) =>
          !members.has(file.relativePath) && file.groupMembers?.some((path) => members.has(path)),
      )
    )
      throw rejected('This disc has shared, missing, or unsupported tracks.');
    if (group.reduce((sum, file) => sum + file.size, 0) > inputLimit)
      throw rejected('The disc exceeds the conversion size limit.');
    const chdman = await discover(
      context.matchingTools?.chdman ?? process.env.ECS_CHDMAN_PATH,
      process.platform === 'win32' ? ['chdman.exe'] : ['chdman'],
    );
    if (!chdman)
      throw new DomainError('disc-conversion-unavailable', 503, 'Install chdman to convert discs.');
    const relativePath = source.relativePath.replace(/\.[^.]+$/, '.chd');
    const destination = await resolveInside(root.path, relativePath, { pinnedRoot: true });
    if (destination !== resolve(root.path, relativePath))
      throw rejected('A CHD with this name already exists.');
    const work = await mkdtemp(join(dirname(destination), '.ecs-chd-'));
    const media = join(work, 'media');
    const originals = join(work, 'originals');
    const moved: { from: string; to: string }[] = [];
    let published = false;
    let committed = false;
    let recovery = false;
    try {
      await mkdir(media);
      const inputs = await Promise.all(
        group.map(async (file) => ({ file, ...(await snapshot(context, root.path, file)) })),
      );
      let input = source.relativePath;
      if (wrapped) {
        const [zip] = inputs;
        if (!zip) throw rejected('The ZIP is unavailable.');
        input = await unpackZip(zip.path, media, signal);
      } else {
        for (const entry of inputs) {
          signal.throwIfAborted();
          const copy = join(media, entry.file.relativePath);
          await mkdir(dirname(copy), { recursive: true });
          await copyFile(entry.path, copy);
        }
      }
      const scanned = await inspectRoot(media, { pinnedRoot: true, signal });
      const anchor = scanned.files.find((file) => file.relativePath === input);
      if (
        !anchor?.groupMembers?.length ||
        anchor.groupError ||
        anchor.groupMembers.length !== scanned.files.length
      )
        throw rejected('The disc descriptor does not reference exactly the available tracks.');
      if (/\.cue$/i.test(input)) {
        const cue = await readFile(join(media, input), 'utf8');
        if (
          cue
            .split(/\r?\n/)
            .some(
              (line) =>
                line.trim() &&
                !/^\s*(?:REM|TITLE|PERFORMER|SONGWRITER|FILE|TRACK|INDEX|PREGAP|POSTGAP|FLAGS|CATALOG|ISRC)\s/i.test(
                  line,
                ),
            )
        )
          throw rejected('The CUE uses an unsupported directive.');
      }
      const output = join(work, 'disc.chd');
      try {
        await run(chdman, ['createcd', '-np', '2', '-i', join(media, input), '-o', output], {
          cwd: media,
          signal,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        await run(chdman, ['verify', '-i', output], {
          cwd: work,
          signal,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
      } catch {
        signal.throwIfAborted();
        throw rejected('chdman could not create and verify this disc.');
      }
      const verified = await open(output, 'r+');
      try {
        await verified.sync();
      } finally {
        await verified.close();
      }
      for (const entry of inputs) {
        const current = await snapshot(context, root.path, entry.file);
        if (
          current.stat.ino !== entry.stat.ino ||
          current.stat.dev !== entry.stat.dev ||
          current.stat.mtimeNs !== entry.stat.mtimeNs ||
          current.stat.ctimeNs !== entry.stat.ctimeNs
        )
          throw rejected('A disc file changed during conversion.');
      }
      signal.throwIfAborted();
      try {
        await link(output, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw rejected('A CHD with this name already exists.');
        throw error;
      }
      published = true;
      for (const entry of inputs) {
        const current = await snapshot(context, root.path, entry.file);
        if (
          current.stat.ino !== entry.stat.ino ||
          current.stat.dev !== entry.stat.dev ||
          current.stat.ctimeNs !== entry.stat.ctimeNs
        )
          throw rejected('A disc file changed before publication.');
        const to = join(originals, entry.file.relativePath);
        await mkdir(dirname(to), { recursive: true });
        await rename(entry.path, to);
        moved.push({ from: entry.path, to });
        const stored = await lstat(to, { bigint: true });
        if (
          stored.ino !== entry.stat.ino ||
          stored.dev !== entry.stat.dev ||
          stored.mtimeNs !== entry.stat.mtimeNs
        )
          throw rejected('A disc file changed before replacement.');
      }
      const stat = await lstat(destination, { bigint: true });
      catalog.replaceSourceDisc(
        {
          sourceId: id,
          targetRootId: root.id,
          actorId,
          file: {
            relativePath,
            displayName: posix.basename(relativePath),
            size: Number(stat.size),
            blocks: Number(stat.blocks),
            availability: 'local',
            kind: 'rom',
            systemId: source.systemId,
            filesystemIdentity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`,
            mtimeMs: Number(stat.mtimeNs) / 1e6,
          },
        },
        group.filter((file) => file.id !== id).map((file) => file.id),
      );
      committed = true;
      return { sourceId: id, name: posix.basename(relativePath), keptOriginals: keepOriginals };
    } catch (error) {
      // Restore without replacing a file created by another process.
      for (const { from, to } of moved.reverse()) {
        try {
          await link(to, from);
          await unlink(to);
        } catch {
          recovery = true;
        }
      }
      if (published)
        await unlink(destination).catch(() => {
          recovery = true;
        });
      if (recovery)
        throw new DomainError(
          'disc-conversion-recovery',
          500,
          'Conversion stopped. Check the hidden .ecs-chd folder for recovery files.',
        );
      throw error;
    } finally {
      if (!recovery) {
        if (committed && keepOriginals) {
          await rm(media, { recursive: true, force: true }).catch(() => {});
          await rm(join(work, 'disc.chd'), { force: true }).catch(() => {});
        } else await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    }
  } finally {
    release();
  }
}

function start(
  context: ServerContext,
  sourceId: string,
  actorId: string,
  keep: boolean,
  signal?: AbortSignal,
) {
  if (active.has(context))
    throw new DomainError('root-busy', 409, 'Another disc conversion is running.');
  const timeout = AbortSignal.timeout(30 * 60_000);
  const pending = convert(
    context,
    sourceId,
    actorId,
    keep,
    signal ? AbortSignal.any([signal, timeout]) : timeout,
  ).finally(() => active.delete(context));
  active.set(context, pending);
  return pending;
}

export async function autoConvertDiscs(
  context: ServerContext,
  rootId: string,
  ownerId: string,
  signal: AbortSignal,
) {
  const options = await policy(context, rootId);
  if (!options.enabled) return;
  for (const file of context.catalog.listSources(rootId)) {
    signal.throwIfAborted();
    if (file.kind !== 'rom' || file.availability !== 'local' || file.groupAnchor || file.groupError)
      continue;
    if (
      !descriptor.test(file.relativePath) &&
      !(archive.test(file.relativePath) && cdSystems.has(file.systemId?.split('.').at(-1) ?? ''))
    )
      continue;
    try {
      await start(context, file.id, ownerId, options.keepOriginals, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof DomainError) || error.code === 'disc-conversion-recovery') throw error;
      if (error.status === 503 || error.status === 409) break;
    }
  }
}

export function registerDiscConversion(app: FastifyInstance, context: ServerContext) {
  function rootId(params: unknown) {
    const id = (params as { rootId: string }).rootId;
    if (!context.catalog.getContentRoot(id))
      throw new DomainError('not-found', 404, 'Folder not found');
    return id;
  }
  app.get('/api/v1/roots/:rootId/disc-conversion', async (request) => {
    requireOwner(request, 'Only the server owner can configure disc conversion');
    return policy(context, rootId(request.params));
  });
  app.put('/api/v1/roots/:rootId/disc-conversion', async (request) => {
    requireOwner(request, 'Only the server owner can configure disc conversion');
    const id = rootId(request.params);
    const body = jsonObject(request.body);
    if (
      typeof body.enabled !== 'boolean' ||
      (body.keepOriginals !== undefined && typeof body.keepOriginals !== 'boolean')
    )
      throw new DomainError('invalid-body', 400, 'Invalid disc conversion settings');
    const settings = { enabled: body.enabled, keepOriginals: body.keepOriginals === true };
    const dir = join(context.dataDir, 'disc-conversion');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, randomUUID());
    try {
      await writeFile(temporary, JSON.stringify(settings), { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(dir, `${id}.json`));
    } finally {
      await rm(temporary, { force: true });
    }
    return settings;
  });
  app.post('/api/v1/sources/:sourceId/disc-conversion', async (request) => {
    const actor = requireOwner(request, 'Only the server owner can convert discs');
    const id = (request.params as { sourceId: string }).sourceId;
    const body = jsonObject(request.body);
    if (body.keepOriginals !== undefined && typeof body.keepOriginals !== 'boolean')
      throw new DomainError('invalid-body', 400, 'Invalid disc conversion settings');
    return start(context, id, actor.userId, body.keepOriginals === true);
  });
  app.addHook('onClose', async () => {
    await active.get(context)?.catch(() => {});
  });
}
