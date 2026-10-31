import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginError } from './errors.js';
import { type PluginManifest, parseManifest } from './manifest.js';
import { type LoadedWorkflowPlugin, loadWorkflowPlugin } from './workflows/manifest.js';

export interface LoadedPlugin {
  directory: string;
  manifest: PluginManifest;
}

export interface PluginProblem {
  directory: string;
  message: string;
}

export interface PluginLoad {
  plugins: LoadedPlugin[];
  problems: PluginProblem[];
}

export type DiscoveredPlugin =
  | { engine: 'ecs.plugin/1'; plugin: LoadedPlugin }
  | { engine: 'ecs.plugin/2'; plugin: LoadedWorkflowPlugin };

/** Mixed-version discovery is opt-in; v1 callers retain their existing result type. */
export async function discoverPlugin(directory: string): Promise<DiscoveredPlugin> {
  const manifest = JSON.parse(await readFile(join(directory, 'plugin.json'), 'utf8'));
  return manifest?.engine === 'ecs.plugin/2'
    ? { engine: 'ecs.plugin/2', plugin: await loadWorkflowPlugin(directory) }
    : { engine: 'ecs.plugin/1', plugin: await loadPlugin(directory) };
}

/** One broken plugin is reported and the rest still load. */
export async function loadPluginDirectory(directory: string): Promise<PluginLoad> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new PluginError('offline', `Plugin directory ${directory} is not available`);
  }
  const plugins: LoadedPlugin[] = [];
  const problems: PluginProblem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDirectory = join(directory, entry.name);
    try {
      plugins.push(await loadPlugin(pluginDirectory));
    } catch (error) {
      problems.push({
        directory: pluginDirectory,
        message: error instanceof Error ? error.message : 'unreadable plugin',
      });
    }
  }
  plugins.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return { plugins, problems };
}

export async function loadPlugin(directory: string): Promise<LoadedPlugin> {
  let text: string;
  try {
    text = await readFile(join(directory, 'plugin.json'), 'utf8');
  } catch {
    throw new PluginError('invalid-manifest', 'plugin.json is missing');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PluginError('invalid-manifest', 'plugin.json is not JSON');
  }
  return { directory, manifest: parseManifest(parsed) };
}
