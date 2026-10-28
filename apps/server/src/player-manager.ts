import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '@ecs/domain';
import { PLAYER_PACKAGE_LIMIT, parseManifest, parsePlayerPackage } from '@ecs/plugins';
import type { PlayerConfiguration, PlayerManagement } from '@ecs/protocol';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from './context.js';
import { requireOwner } from './http.js';
import { readRegular } from './player-assets.js';
import { playerCatalog, type TrustedPlayer } from './player-catalog.js';
import { downloadCatalogPlayer } from './player-download.js';
import { MAX_PLAYER_PROFILES, MAX_PLAYER_SNAPSHOT_BYTES } from './player-limits.js';
import { loadPlayerProfiles, type PlayerProfileAssets } from './player-profiles.js';

interface Settings {
  disabled: string[];
  defaultId: string | null;
}
export class PlayerManager {
  private legacy: ServerContext['player'];
  private all = new Map<string, PlayerProfileAssets>();
  private managed = new Set<string>();
  private settings: Settings = { disabled: [], defaultId: null };
  private tail: Promise<unknown> = Promise.resolve();
  private root: string;
  private stateFile: string;
  constructor(
    private context: ServerContext,
    private operators: ReadonlyMap<string, PlayerProfileAssets>,
    private catalog: readonly TrustedPlayer[] = playerCatalog,
  ) {
    this.legacy = context.player;
    this.root = join(context.dataDir, 'players');
    this.stateFile = join(context.dataDir, 'player-settings.json');
  }
  async initialize() {
    await mkdir(this.root, { recursive: true });
    if (!(await lstat(this.root)).isDirectory())
      throw new Error('Invalid managed player directory');
    try {
      if (!(await lstat(this.stateFile)).isFile()) throw new Error('Invalid player settings');
      const s = JSON.parse(
        (await readRegular(this.context.dataDir, 'player-settings.json', 65536)).toString('utf8'),
      );
      if (
        !Array.isArray(s.disabled) ||
        s.disabled.length > MAX_PLAYER_PROFILES ||
        s.disabled.some((id: unknown) => typeof id !== 'string' || id.length > 120) ||
        (s.defaultId !== null && typeof s.defaultId !== 'string')
      )
        throw new Error('Invalid player settings');
      this.settings = s;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const initial = await this.reload();
    this.all = initial.all;
    this.managed = initial.managed;
    this.publish();
  }
  private async reload() {
    const managed = await loadPlayerProfiles(this.root);
    const all = new Map(this.operators);
    for (const [id, profile] of managed.items) {
      if (all.has(id))
        throw new DomainError('conflict', 409, 'An operator emulator already uses this identifier');
      all.set(id, profile);
    }
    let bytes = 0;
    for (const p of all.values())
      bytes +=
        p.loader.length + p.wasm.length + [...p.assets.values()].reduce((n, b) => n + b.length, 0);
    if (all.size > MAX_PLAYER_PROFILES || bytes > MAX_PLAYER_SNAPSHOT_BYTES)
      throw new DomainError('conflict', 409, 'Emulator installation limit reached');
    return { all, managed: new Set(managed.items.keys()) };
  }
  private publish() {
    const enabled = new Map(
      [...this.all]
        .filter(([id]) => !this.settings.disabled.includes(id))
        .map(([id, p]) => [
          id,
          id === 'org.libretro.parallel-dc' && !p.assets.has('awbios.zip')
            ? {
                ...p,
                descriptor: {
                  ...p.descriptor,
                  systems: p.descriptor.systems.filter(
                    (system) => system !== 'com.provenance.atomiswave',
                  ),
                },
              }
            : p,
        ]),
    );
    for (const [id, p] of enabled) if (!p.descriptor.systems.length) enabled.delete(id);
    this.context.player =
      this.legacy && enabled.has(this.legacy.descriptor.id) ? this.legacy : undefined;
    this.context.defaultPlayerProfileId =
      this.settings.defaultId && enabled.has(this.settings.defaultId)
        ? this.settings.defaultId
        : (enabled.keys().next().value ?? null);
    const preferred = this.context.defaultPlayerProfileId;
    this.context.playerProfiles = new Map(
      [...enabled].sort(([a], [b]) => (a === preferred ? 0 : 1) - (b === preferred ? 0 : 1)),
    );
  }
  private async persist(
    settings: Settings,
    snapshot?: { all: Map<string, PlayerProfileAssets>; managed: Set<string> },
  ) {
    const temporary = join(this.context.dataDir, `player-settings-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(settings), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.stateFile);
    } finally {
      await rm(temporary, { force: true });
    }
    this.settings = settings;
    if (snapshot) {
      this.all = snapshot.all;
      this.managed = snapshot.managed;
    }
    this.publish();
  }
  view(): PlayerManagement {
    return {
      items: [...this.all].map(([id, p]) => ({
        profile: p.descriptor,
        enabled: !this.settings.disabled.includes(id),
        source: this.managed.has(id) ? 'managed' : 'operator',
        removable: this.managed.has(id),
      })),
      defaultProfileId: this.context.defaultPlayerProfileId,
      available: this.catalog.map(({ url: _, sha256: __, upstream: ___, ...entry }) => entry),
    };
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
  configure(id: string, patch: PlayerConfiguration) {
    return this.serial(async () => {
      if (!this.all.has(id)) throw new DomainError('not-found', 404, 'Emulator is not installed');
      if (
        !patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        Object.keys(patch).some((k) => !['enabled', 'default'].includes(k)) ||
        !Object.keys(patch).length ||
        Object.values(patch).some((v) => typeof v !== 'boolean')
      )
        throw new DomainError('invalid-request', 400, 'Choose enabled or default');
      const settings = {
        disabled: [...this.settings.disabled],
        defaultId: this.settings.defaultId,
      };
      if (patch.enabled === false) {
        if (!settings.disabled.includes(id)) settings.disabled.push(id);
        if (settings.defaultId === id) settings.defaultId = null;
      }
      if (patch.enabled === true) settings.disabled = settings.disabled.filter((x) => x !== id);
      if (patch.default === true) {
        if (settings.disabled.includes(id))
          throw new DomainError('conflict', 409, 'Enable the emulator before making it default');
        settings.defaultId = id;
      }
      if (patch.default === false && settings.defaultId === id) settings.defaultId = null;
      await this.persist(settings);
      return this.view();
    });
  }
  remove(id: string) {
    return this.serial(async () => {
      if (!this.all.has(id)) throw new DomainError('not-found', 404, 'Emulator is not installed');
      if (!this.managed.has(id))
        throw new DomainError(
          'forbidden',
          403,
          'Operator installations are read-only; disable this emulator instead',
        );
      const source = join(this.root, id),
        retired = join(this.context.dataDir, `player-removed-${randomUUID()}`);
      await rename(source, retired);
      const previous = this.all,
        previousManaged = this.managed;
      try {
        const snapshot = await this.reload();
        await this.persist(
          {
            disabled: this.settings.disabled.filter((x) => x !== id),
            defaultId: this.settings.defaultId === id ? null : this.settings.defaultId,
          },
          snapshot,
        );
      } catch (error) {
        await rename(retired, source);
        this.all = previous;
        this.managed = previousManaged;
        throw error;
      }
      await rm(retired, { recursive: true, force: true });
      return this.view();
    });
  }
  install(bytes: Uint8Array) {
    return this.serial(() => this.installBytes(bytes));
  }
  private async installBytes(bytes: Uint8Array) {
    let parsed: ReturnType<typeof parsePlayerPackage>;
    try {
      parsed = parsePlayerPackage(bytes);
    } catch {
      throw new DomainError(
        'invalid-request',
        400,
        'Invalid emulator package: check its manifest, resource hashes and size limits',
      );
    }
    const id = parsed.manifest.id;
    if (this.all.has(id)) throw new DomainError('conflict', 409, 'Emulator is already installed');
    const stage = join(this.context.dataDir, `player-staging-${randomUUID()}`),
      profileDir = join(stage, id),
      destination = join(this.root, id);
    const previous = this.all,
      previousManaged = this.managed;
    let installed = false;
    try {
      await mkdir(profileDir, { recursive: true });
      await writeFile(join(profileDir, 'plugin.json'), JSON.stringify(parsed.manifest), {
        flag: 'wx',
      });
      for (const [name, content] of parsed.files)
        await writeFile(join(profileDir, name), content, { flag: 'wx' });
      try {
        await loadPlayerProfiles(stage);
      } catch {
        throw new DomainError(
          'invalid-request',
          400,
          'Emulator package contains an invalid runtime profile or WASM binary',
        );
      }
      try {
        await lstat(destination);
        throw new DomainError('conflict', 409, 'Emulator installation directory already exists');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(profileDir, destination);
      installed = true;
      const snapshot = await this.reload();
      await this.persist(
        {
          disabled: this.settings.disabled.filter((x) => x !== id),
          defaultId: this.settings.defaultId,
        },
        snapshot,
      );
      return this.view();
    } catch (error) {
      if (installed) await rm(destination, { recursive: true, force: true });
      this.all = previous;
      this.managed = previousManaged;
      throw error;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  systemFile(id: string, name: string, bytes: Buffer) {
    return this.serial(async () => {
      if (!this.all.has(id)) throw new DomainError('not-found', 404, 'Emulator is not installed');
      if (id !== 'org.libretro.parallel-dc' || !this.managed.has(id))
        throw new DomainError(
          'forbidden',
          403,
          'System files can be added only to the managed Dreamcast/arcade emulator',
        );
      if (name !== 'awbios.zip' || !validAtomiswaveArchive(bytes))
        throw new DomainError(
          'invalid-request',
          400,
          'Select awbios.zip containing bios0.ic23 (131072bytes), up to32MiB',
        );
      const current = this.all.get(id);
      if (!current) throw new DomainError('not-found', 404, 'Emulator is not installed');
      const source = join(this.root, id),
        stage = join(this.context.dataDir, `player-staging-${randomUUID()}`),
        next = join(stage, id),
        retired = join(this.context.dataDir, `player-replaced-${randomUUID()}`);
      const manifest = parseManifest(
        JSON.parse((await readRegular(source, 'plugin.json', 65536)).toString('utf8')),
      );
      const web = manifest.player?.web;
      if (!web) throw new DomainError('invalid-request', 400, 'Browser emulator manifest required');
      const files = new Map<string, Buffer>([
        [web.loader.file, current.loader],
        [web.wasm.file, current.wasm],
      ]);
      for (const spec of web.assets)
        if (spec.name !== name) {
          const value = current.assets.get(spec.name);
          if (!value) throw new Error('Missing player resource');
          files.set(spec.file, value);
        }
      web.assets = web.assets.filter((a) => a.name !== name);
      if (
        web.assets.length >= 16 ||
        [...current.assets]
          .filter(([n]) => n !== name)
          .reduce((total, [, b]) => total + b.length, bytes.length) >
          32 * 1024 * 1024
      )
        throw new DomainError('conflict', 409, 'Emulator system-file limit reached');
      web.assets.push({
        name,
        file: `system-${randomUUID()}.zip`,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      const installedFile = web.assets.at(-1);
      if (!installedFile) throw new Error('System file specification missing');
      files.set(installedFile.file, bytes);
      let moved = false,
        activated = false;
      try {
        await mkdir(next, { recursive: true });
        await writeFile(join(next, 'plugin.json'), JSON.stringify(manifest));
        for (const [file, value] of files) await writeFile(join(next, file), value, { flag: 'wx' });
        await loadPlayerProfiles(stage);
        await rename(source, retired);
        moved = true;
        await rename(next, source);
        activated = true;
        const snapshot = await this.reload();
        await this.persist(this.settings, snapshot);
      } catch (error) {
        if (activated) await rm(source, { recursive: true, force: true });
        if (moved) await rename(retired, source);
        throw error;
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
      await rm(retired, { recursive: true, force: true });
      return this.view();
    });
  }
  installCatalog(id: string) {
    return this.serial(async () => {
      const entry = this.catalog.find((p) => p.id === id && p.available);
      if (!entry)
        throw new DomainError('not-found', 404, 'This emulator is not available to install yet');
      if (this.all.has(id)) throw new DomainError('conflict', 409, 'Emulator is already installed');
      const bytes = await downloadCatalogPlayer(entry);
      return this.installBytes(bytes);
    });
  }
}

function validAtomiswaveArchive(bytes: Buffer) {
  if (bytes.length < 22 || bytes.length > 32 * 1024 * 1024) return false;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (
      bytes.readUInt32LE(at) !== 0x06054b50 ||
      at + 22 + bytes.readUInt16LE(at + 20) !== bytes.length
    )
      continue;
    if (bytes.readUInt16LE(at + 4) || bytes.readUInt16LE(at + 6)) return false;
    const count = bytes.readUInt16LE(at + 10),
      size = bytes.readUInt32LE(at + 12),
      start = bytes.readUInt32LE(at + 16);
    if (!count || count > 32 || start + size > at) return false;
    let cursor = start,
      found = false;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > start + size || bytes.readUInt32LE(cursor) !== 0x02014b50) return false;
      const len = bytes.readUInt16LE(cursor + 28),
        extra = bytes.readUInt16LE(cursor + 30),
        comment = bytes.readUInt16LE(cursor + 32),
        end = cursor + 46 + len + extra + comment;
      if (end > start + size) return false;
      const name = bytes.subarray(cursor + 46, cursor + 46 + len).toString('utf8');
      if (
        name === 'bios0.ic23' &&
        bytes.readUInt32LE(cursor + 24) === 131072 &&
        !(bytes.readUInt16LE(cursor + 8) & 1) &&
        [0, 8].includes(bytes.readUInt16LE(cursor + 10))
      )
        found = true;
      cursor = end;
    }
    return found && cursor === start + size;
  }
  return false;
}

export function registerPlayerManagement(app: FastifyInstance, context: ServerContext) {
  const manager = context.playerManager;
  if (!manager) throw new Error('Player manager is not initialized');
  app.register(async (router) => {
    const owner = async (request: import('fastify').FastifyRequest) => {
      if (!request.headers.authorization)
        throw new DomainError('forbidden', 403, 'Sign in as the server owner to manage emulators');
      requireOwner(request, 'Sign in as the server owner to manage emulators');
    };
    router.addContentTypeParser(
      'application/vnd.ecs.player-package',
      { parseAs: 'buffer', bodyLimit: PLAYER_PACKAGE_LIMIT },
      (_request, body, done) => done(null, body),
    );
    router.addContentTypeParser(
      'application/vnd.ecs.player-system-file',
      { parseAs: 'buffer', bodyLimit: 32 * 1024 * 1024 },
      (_request, body, done) => done(null, body),
    );
    const options = { onRequest: owner };
    router.put<{ Params: { id: string; name: string } }>(
      '/api/v1/player/management/:id/system/:name',
      { ...options, bodyLimit: 32 * 1024 * 1024 },
      async (request) =>
        manager.systemFile(request.params.id, request.params.name, request.body as Buffer),
    );
    router.get('/api/v1/player/management', options, async () => manager.view());
    router.post(
      '/api/v1/player/management/install',
      { ...options, bodyLimit: PLAYER_PACKAGE_LIMIT },
      async (request) => manager.install(request.body as Buffer),
    );
    router.post<{ Params: { id: string } }>(
      '/api/v1/player/management/install/:id',
      options,
      async (request) => manager.installCatalog(request.params.id),
    );
    router.patch<{ Params: { id: string }; Body: PlayerConfiguration }>(
      '/api/v1/player/management/:id',
      options,
      async (request) => manager.configure(request.params.id, request.body),
    );
    router.delete<{ Params: { id: string } }>(
      '/api/v1/player/management/:id',
      options,
      async (request) => manager.remove(request.params.id),
    );
  });
}
