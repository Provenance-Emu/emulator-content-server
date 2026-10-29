import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOSTED_CATALOG_PIN } from './catalog-release.js';
import { createLibretroCheatsProvider, localCheatsProvider, normalizeCheats } from './cheats.js';
import { createHostedCatalog, type HostedCatalogClient } from './hosted-catalog.js';
import { createLibretroProvider } from './libretro-matching.js';
import { localMatchingProvider, type MatchingProvider, runMatching } from './matching.js';
import type { MatchingJob, MatchingPluginDescription, MatchingReply } from './matching-host.js';
import { pluginFile } from './paths.js';
import { type LoadedPlugin, loadPluginDirectory, type PluginLoad } from './registry.js';
import { type IdentificationPlugin, identifyRom } from './rom-identification.js';

const modules = new WeakMap<LoadedPlugin, Promise<Record<string, unknown>>>();
function entry(plugin: LoadedPlugin): Promise<Record<string, unknown>> {
  let module = modules.get(plugin);
  if (!module) {
    module = loadEntry(plugin);
    modules.set(plugin, module);
  }
  return module;
}
async function loadEntry(plugin: LoadedPlugin): Promise<Record<string, unknown>> {
  const directory = await realpath(plugin.directory);
  if (!plugin.manifest.entry) throw new Error('Missing entry');
  const path = await realpath(pluginFile(directory, plugin.manifest.entry));
  const rel = relative(directory, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Plugin entry escapes directory');
  const module = (await import(pathToFileURL(path).href)) as { default?: Record<string, unknown> };
  if (!module.default || typeof module.default !== 'object')
    throw new Error('Missing plugin export');
  return module.default;
}

const hostedCache = new Map<string, HostedCatalogClient>();
function hosted(directory?: string): HostedCatalogClient {
  const key = directory ?? '';
  let client = hostedCache.get(key);
  if (!client) {
    client = createHostedCatalog({ pin: HOSTED_CATALOG_PIN, cacheDirectory: directory });
    hostedCache.set(key, client);
    if (hostedCache.size > 2) hostedCache.delete(hostedCache.keys().next().value ?? '');
  }
  return client;
}
async function hasHostedCheats(
  client: HostedCatalogClient,
  systemId: string | null,
  signal?: AbortSignal,
): Promise<boolean> {
  return (
    !!HOSTED_CATALOG_PIN &&
    !!systemId &&
    (await client.index(signal)).shards.some(
      (shard) => shard.kind === 'cheats' && shard.systemId === systemId,
    )
  );
}

const builtinCache = new Map<string, MatchingProvider[]>();
const registryCache = new Map<string, { expires: number; loaded: Promise<PluginLoad> }>();
let activeSearches = 0;
function builtins(directory?: string): MatchingProvider[] {
  const key = directory ?? '';
  let providers = builtinCache.get(key);
  if (!providers) {
    const catalog = hosted(directory),
      catalogProviders = catalog.providers();
    const hostedCheats = catalogProviders.find(
      (provider) => provider.id === 'org.ecs.catalog.cheats',
    );
    const legacyCheats = createLibretroCheatsProvider();
    providers = [
      localMatchingProvider,
      {
        ...createLibretroProvider(fetch, directory, catalog.metadata),
        name: HOSTED_CATALOG_PIN
          ? `Hosted game catalogs and artwork · ${HOSTED_CATALOG_PIN.release}`.slice(0, 80)
          : 'Game catalogs and artwork',
      },
      localCheatsProvider,
      {
        ...legacyCheats,
        async search(input, signal) {
          return hostedCheats && (await hasHostedCheats(catalog, input.systemId, signal))
            ? hostedCheats.search(input, signal)
            : legacyCheats.search(input, signal);
        },
      },
      ...catalogProviders.filter((provider) => provider.id !== 'org.ecs.catalog.metadata'),
    ];
    builtinCache.set(key, providers);
    if (builtinCache.size > 2) builtinCache.delete(builtinCache.keys().next().value ?? '');
  }
  return [...providers];
}
async function installed(directory?: string): Promise<PluginLoad> {
  if (!directory) return { plugins: [], problems: [] };
  const cached = registryCache.get(directory);
  if (cached && cached.expires > performance.now()) return cached.loaded;
  const loaded = loadPluginDirectory(directory);
  registryCache.delete(directory);
  registryCache.set(directory, { loaded, expires: performance.now() + 5000 });
  if (registryCache.size > 2) registryCache.delete(registryCache.keys().next().value ?? '');
  try {
    return await loaded;
  } catch (error) {
    registryCache.delete(directory);
    throw error;
  }
}
export async function executeMatchingJob(job: MatchingJob): Promise<MatchingReply> {
  if (job.operation === 'catalog-sync') {
    return {
      plugins: [],
      catalogSync: await hosted(job.catalogCacheDirectory).sync(
        { systemIds: job.catalogSystems },
        AbortSignal.timeout(110000),
      ),
    };
  }
  if (job.operation === 'catalog-resource') {
    if (!job.catalogResource) throw new Error('Missing hosted resource reference');
    const resource = await hosted(job.catalogCacheDirectory).resource(
      job.catalogResource,
      AbortSignal.timeout(8000),
    );
    return {
      plugins: [],
      file: Buffer.from(resource.bytes).toString('base64'),
      catalogResource: {
        kind: resource.kind,
        format: resource.format,
        sha256: resource.sha256,
        bytes: resource.bytes.byteLength,
        release: resource.release,
      },
    };
  }
  if (job.operation === 'identify') {
    if (!job.identification) throw new Error('Missing identification request');
    const loaded = await installed(job.directory);
    const identifiers: IdentificationPlugin[] = [];
    for (const path of job.identifierModules ?? []) {
      const loaded = await import(pathToFileURL(path).href);
      const plugin = loaded.default as IdentificationPlugin;
      if (
        !plugin ||
        typeof plugin.id !== 'string' ||
        typeof plugin.supports !== 'function' ||
        typeof plugin.identify !== 'function'
      )
        throw new Error('Invalid host identification adapter');
      identifiers.push(plugin);
    }
    for (const plugin of loaded.plugins) {
      if (
        plugin.manifest.kind !== 'provider' ||
        plugin.manifest.provider?.network ||
        !plugin.manifest.provider?.capabilities.includes('rom')
      )
        continue;
      const module = await entry(plugin);
      if (typeof module.identify !== 'function') continue;
      const identify = module.identify as IdentificationPlugin['identify'];
      identifiers.push({
        id: plugin.manifest.id,
        supports: () => true,
        identify: (request, reader, signal) => identify(request, reader, signal),
      });
    }
    return { plugins: [], facts: await identifyRom(job.identification, undefined, identifiers) };
  }
  if (job.operation === 'artwork' || job.operation === 'cheats') {
    const url = new URL(job.artworkUrl ?? '');
    if (
      url.origin !== 'https://raw.githubusercontent.com' ||
      !(job.operation === 'artwork'
        ? url.pathname.startsWith('/libretro-thumbnails/')
        : url.pathname.startsWith('/libretro/libretro-database/master/cht/') &&
          url.pathname.endsWith('.cht')) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid artwork URL');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok || !response.body) throw new Error('Artwork unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        size += read.value.byteLength;
        if (size > (job.operation === 'artwork' ? 2 * 1024 * 1024 : 256 * 1024))
          throw new Error('Artwork too large');
        chunks.push(read.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const bytes = Buffer.concat(chunks);
    if (job.operation === 'cheats')
      return { plugins: [], file: Buffer.from(normalizeCheats(bytes).text).toString('base64') };
    return { plugins: [], artwork: bytes.toString('base64') };
  }
  const providers = builtins(job.catalogCacheDirectory);
  const loaded = await installed(job.directory);
  const managers = loaded.plugins.filter((p) => p.manifest.kind === 'manager');
  const plugins: MatchingPluginDescription[] = [
    ...providers.map((p) => ({
      id: p.id,
      name: p.name,
      kind: 'provider' as const,
      capabilities: p.capabilities,
      network: p.network,
    })),
    {
      id: 'org.ecs.matches',
      name: 'Default match manager',
      kind: 'manager',
      capabilities: [],
      network: false,
    },
  ];
  const ids = new Set([...plugins.map((p) => p.id), 'org.ecs.catalog.metadata']);
  for (const plugin of loaded.plugins) {
    const manifest = plugin.manifest;
    if (manifest.kind !== 'provider' && manifest.kind !== 'manager') continue;
    if (ids.has(manifest.id)) throw new Error('Duplicate matching plugin id');
    ids.add(manifest.id);
    plugins.push({
      id: manifest.id,
      name: manifest.name,
      kind: manifest.kind,
      capabilities: manifest.provider?.capabilities ?? [],
      network: manifest.provider?.network ?? false,
    });
    if (manifest.kind === 'provider' && manifest.provider)
      providers.push({
        id: manifest.id,
        name: manifest.name,
        capabilities: manifest.provider.capabilities,
        network: manifest.provider.network,
        async search(input, signal) {
          const module = await entry(plugin);
          if (typeof module.search !== 'function') {
            if (typeof module.identify === 'function') return [];
            throw new Error('Missing provider search');
          }
          return module.search(input, signal);
        },
      });
  }
  if (job.operation === 'list') return { plugins };
  if (!job.input) throw new Error('Missing matching input');
  let chosen = job.providerIds;
  if (job.managerId && job.managerId !== 'org.ecs.matches') {
    const manager = managers.find((p) => p.manifest.id === job.managerId);
    if (!manager) throw new Error('Unknown manager');
    const module = await entry(manager);
    if (typeof module.selectProviders !== 'function') throw new Error('Missing manager selection');
    if (!manager.manifest.manager) throw new Error('Missing manager config');
    const allowed = manager.manifest.manager.providers;
    const selected: unknown = await module.selectProviders(
      job.input,
      plugins.filter((p) => p.kind === 'provider' && allowed.includes(p.id)),
    );
    if (
      !Array.isArray(selected) ||
      selected.length > 32 ||
      selected.some(
        (id) =>
          typeof id !== 'string' || !allowed.includes(id) || !providers.some((p) => p.id === id),
      ) ||
      new Set(selected).size !== selected.length
    )
      throw new Error('Invalid manager selection');
    chosen = selected as string[];
    const requested = job.providerIds;
    if (requested) chosen = chosen.filter((id) => requested.includes(id));
  }
  if (chosen && (chosen.length > 32 || chosen.some((id) => !providers.some((p) => p.id === id))))
    throw new Error('Unknown provider');
  const selected = chosen
    ? chosen.map((id) => {
        const provider = providers.find((p) => p.id === id);
        if (!provider) throw new Error('Unknown provider');
        return provider;
      })
    : providers;
  return {
    plugins,
    result: await runMatching(
      job.input,
      selected.map((provider) => ({
        ...provider,
        async search(input, signal) {
          activeSearches++;
          try {
            if (
              provider.id === 'org.ecs.cheats.libretro' &&
              selected.some((other) => other.id === 'org.ecs.catalog.cheats') &&
              (await hasHostedCheats(hosted(job.catalogCacheDirectory), input.systemId, signal))
            )
              return [];
            return await provider.search(input, signal);
          } finally {
            activeSearches--;
          }
        },
      })),
    ),
  };
}

function request(raw: unknown): { id: string; job: MatchingJob } {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Buffer.byteLength(JSON.stringify(raw)) > 512 * 1024 + 256
  )
    throw new Error('Invalid request');
  const envelope = raw as { id: unknown; job: MatchingJob };
  const job = envelope.job;
  if (
    Object.keys(raw).length !== 2 ||
    typeof envelope.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(envelope.id) ||
    !job ||
    typeof job !== 'object' ||
    Array.isArray(job) ||
    ![
      'list',
      'match',
      'artwork',
      'cheats',
      'identify',
      'catalog-sync',
      'catalog-resource',
    ].includes(job.operation)
  )
    throw new Error('Invalid request');
  if (
    job.catalogSystems !== undefined &&
    (!Array.isArray(job.catalogSystems) ||
      job.catalogSystems.length > 64 ||
      job.catalogSystems.some(
        (value) => typeof value !== 'string' || !/^[a-zA-Z0-9]+(?:\.[a-zA-Z0-9_-]+)+$/.test(value),
      ))
  )
    throw new Error('Invalid catalog systems');
  if (
    job.operation === 'catalog-resource' &&
    (!job.catalogResource ||
      typeof job.catalogResource !== 'object' ||
      Object.keys(job.catalogResource).sort().join(',') !== 'recordId,release,shardId' ||
      Object.values(job.catalogResource).some(
        (value) =>
          typeof value !== 'string' ||
          value.length > 120 ||
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value),
      ))
  )
    throw new Error('Invalid hosted resource reference');
  for (const path of [job.directory, job.catalogCacheDirectory])
    if (path !== undefined && (typeof path !== 'string' || path.length > 4096))
      throw new Error('Invalid directory');
  if (
    job.operation === 'match' &&
    (!job.input || typeof job.input.name !== 'string' || !Array.isArray(job.input.companions))
  )
    throw new Error('Invalid input');
  if (
    job.operation === 'identify' &&
    (!job.identification ||
      typeof job.identification.path !== 'string' ||
      !isAbsolute(job.identification.path) ||
      job.identification.path.length > 4096 ||
      typeof job.identification.name !== 'string' ||
      job.identification.name.length > 512 ||
      !Number.isSafeInteger(job.identification.size) ||
      job.identification.size < 0)
  )
    throw new Error('Invalid identification source');
  if (
    job.identifierModules !== undefined &&
    (!Array.isArray(job.identifierModules) ||
      job.identifierModules.length > 8 ||
      job.identifierModules.some(
        (path) => typeof path !== 'string' || path.length > 4096 || !isAbsolute(path),
      ))
  )
    throw new Error('Invalid identification adapters');
  return { id: envelope.id, job };
}
if (process.send) {
  let busy = false;
  let scope: string | undefined;
  process.on('disconnect', () => process.exit(0));
  process.on('message', (raw: unknown) => {
    let id: string, job: MatchingJob;
    try {
      ({ id, job } = request(raw));
      const key = JSON.stringify([job.directory ?? null, job.catalogCacheDirectory ?? null]);
      if (busy || (scope !== undefined && scope !== key))
        throw new Error('Worker scope/overlap violation');
      scope = key;
      busy = true;
    } catch {
      process.exit(1);
    }
    void executeMatchingJob(job).then(
      (reply) => {
        try {
          if (
            Buffer.byteLength(JSON.stringify(reply)) >
            (['artwork', 'catalog-resource'].includes(job.operation) ? 3 * 1024 * 1024 : 512 * 1024)
          )
            throw new Error('Reply too large');
          // A provider that ignores its own deadline must not run alongside the next job.
          const recycle = activeSearches > 0;
          busy = recycle;
          process.send?.({ id, reply, recycle }, (error) => {
            if (error) process.exit(1);
          });
        } catch {
          process.exit(1);
        }
      },
      () => process.exit(1),
    );
  });
}
