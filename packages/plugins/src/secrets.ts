import { readFile, stat } from 'node:fs/promises';
import type { CloudSecrets } from './cloud.js';
import { PluginError } from './errors.js';

const SECRET_FIELDS = ['accessKeyId', 'secretAccessKey', 'sessionToken', 'accessToken'] as const;

/**
 * Connector credentials live in their own file, mode 0600, never in plugin.json
 * and never in the content server's data directory.
 */
export async function readSecrets(path: string): Promise<CloudSecrets> {
  const info = await stat(path).catch(() => {
    throw new PluginError('missing-secret', 'secrets.json is missing');
  });
  if (!info.isFile()) throw new PluginError('missing-secret', 'secrets.json is not a file');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new PluginError(
      'secret-permissions',
      'secrets.json must be readable only by the user that runs the plugin host',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new PluginError('missing-secret', 'secrets.json is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PluginError('missing-secret', 'secrets.json must be an object');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(SECRET_FIELDS as readonly string[]).includes(key)) {
      throw new PluginError('missing-secret', `secrets.json has unknown field ${key}`);
    }
    if (typeof record[key] !== 'string' || record[key] === '') {
      throw new PluginError('missing-secret', `${key} must be a string`);
    }
  }
  const secrets: CloudSecrets = {};
  for (const field of SECRET_FIELDS) {
    const value = record[field];
    if (typeof value === 'string') secrets[field] = value;
  }
  return secrets;
}
