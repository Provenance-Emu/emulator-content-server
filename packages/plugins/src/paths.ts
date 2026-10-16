import { isAbsolute, relative, resolve, sep } from 'node:path';
import { PluginError } from './errors.js';

export function httpsUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PluginError('invalid-manifest', 'URL must be https');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new PluginError('invalid-manifest', 'URL must be https and must not carry credentials');
  }
  return url.href;
}

/**
 * The same relative-path rule the content contract enforces. A connector that
 * accepted a different shape would upload a path the server then refuses.
 */
export function safeRelativePath(input: string): string {
  if (input.length === 0 || input.length > 1024 || input.includes('\0')) {
    throw new PluginError('invalid-path', 'Relative path is empty or too long');
  }
  const normalized = input.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new PluginError('invalid-path', 'Relative path must not be absolute');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new PluginError('invalid-path', 'Relative path contains an empty or parent segment');
  }
  return parts.join('/');
}

/** A file named by a plugin, resolved inside that plugin's own directory. */
export function pluginFile(directory: string, relativePath: string): string {
  if (relativePath.startsWith('/') || relativePath.includes('\\')) {
    throw new PluginError('path-escape', 'A plugin file must stay inside its directory');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => part.length === 0 || part === '..')) {
    throw new PluginError('path-escape', 'A plugin file must stay inside its directory');
  }
  const resolved = resolve(directory, ...parts);
  const rel = relative(directory, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new PluginError('path-escape', 'A plugin file must stay inside its directory');
  }
  return resolved;
}

export function hiddenPath(relativePath: string): boolean {
  return relativePath.split('/').some((part) => part.startsWith('.'));
}
