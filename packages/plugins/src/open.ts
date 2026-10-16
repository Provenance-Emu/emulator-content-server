import { pathToFileURL } from 'node:url';
import { type CloudFetch, type CloudSecrets, openCloudConnector } from './cloud.js';
import type { StorageConnector } from './connector.js';
import { PluginError } from './errors.js';
import { HTTP_SCHEMES, MOUNT_SCHEMES } from './manifest.js';
import { openMount } from './mount.js';
import { pluginFile } from './paths.js';
import type { LoadedPlugin } from './registry.js';

export interface OpenOptions {
  secrets?: CloudSecrets;
  fetch?: CloudFetch;
  now?: () => Date;
}

export async function openConnector(
  plugin: LoadedPlugin,
  options: OpenOptions = {},
): Promise<StorageConnector> {
  const manifest = plugin.manifest;
  if (manifest.kind !== 'connector' || !manifest.connector) {
    throw new PluginError('invalid-manifest', `${manifest.id} is not a connector`);
  }
  if (manifest.entry) return openEntry(plugin, options);
  const connector = manifest.connector;
  if (MOUNT_SCHEMES.has(connector.scheme)) {
    return openMount({
      id: manifest.id,
      scheme: connector.scheme,
      root: connector.root ?? '',
      ignoreHidden: connector.ignoreHidden,
      kinds: connector.kinds,
    });
  }
  if (HTTP_SCHEMES.has(connector.scheme)) {
    if (!options.fetch)
      throw new PluginError('missing-secret', 'An HTTP connector needs a fetch implementation');
    return openCloudConnector({
      id: manifest.id,
      scheme: connector.scheme as 's3' | 'googledrive' | 'dropbox' | 'box',
      ...(connector.bucket ? { bucket: connector.bucket } : {}),
      ...(connector.region ? { region: connector.region } : {}),
      ...(connector.prefix !== undefined ? { prefix: connector.prefix } : {}),
      ...(connector.endpoint ? { endpoint: connector.endpoint } : {}),
      ...(connector.folderId ? { folderId: connector.folderId } : {}),
      secrets: options.secrets ?? {},
      fetch: options.fetch,
      ...(options.now ? { now: options.now } : {}),
    });
  }
  throw new PluginError('invalid-manifest', `${connector.scheme} needs an entry module`);
}

async function openEntry(plugin: LoadedPlugin, options: OpenOptions): Promise<StorageConnector> {
  const entry = plugin.manifest.entry;
  if (!entry) throw new PluginError('invalid-manifest', 'A custom connector needs an entry module');
  const href = pathToFileURL(pluginFile(plugin.directory, entry)).href;
  const imported = (await import(href)) as {
    createConnector?: (
      input: OpenOptions & { plugin: LoadedPlugin },
    ) => Promise<StorageConnector> | StorageConnector;
  };
  if (typeof imported.createConnector !== 'function') {
    throw new PluginError('invalid-manifest', `${entry} does not export createConnector`);
  }
  return imported.createConnector({ ...options, plugin });
}
