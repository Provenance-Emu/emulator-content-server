import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLibretroProvider } from './libretro-matching.js';
import { localMatchingProvider, type MatchingProvider, runMatching } from './matching.js';
import type { MatchingJob, MatchingPluginDescription, MatchingReply } from './matching-host.js';
import { pluginFile } from './paths.js';
import { type LoadedPlugin, loadPluginDirectory } from './registry.js';

async function entry(plugin: LoadedPlugin): Promise<Record<string, unknown>> {
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

export async function executeMatchingJob(job: MatchingJob): Promise<MatchingReply> {
  if (job.operation === 'artwork') {
    const url = new URL(job.artworkUrl ?? '');
    if (
      url.origin !== 'https://raw.githubusercontent.com' ||
      !url.pathname.startsWith('/libretro-thumbnails/') ||
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
        if (size > 2 * 1024 * 1024) throw new Error('Artwork too large');
        chunks.push(read.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return { plugins: [], artwork: Buffer.concat(chunks).toString('base64') };
  }
  const providers: MatchingProvider[] = [localMatchingProvider, createLibretroProvider()];
  const installed = job.directory
    ? await loadPluginDirectory(job.directory)
    : { plugins: [], problems: [] };
  const managers = installed.plugins.filter((p) => p.manifest.kind === 'manager');
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
  const ids = new Set(plugins.map((p) => p.id));
  for (const plugin of installed.plugins) {
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
          if (typeof module.search !== 'function') throw new Error('Missing provider search');
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
  return { plugins, result: await runMatching(job.input, selected) };
}

if (process.send)
  process.once('message', (job: MatchingJob) => {
    void executeMatchingJob(job).then(
      (reply) => process.send?.(reply),
      () => process.exit(1),
    );
  });
