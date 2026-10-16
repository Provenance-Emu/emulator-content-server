import { stat } from 'node:fs/promises';
import { PluginError } from './errors.js';
import type { PluginManifest } from './manifest.js';
import { pluginFile } from './paths.js';

export interface PlayerDescription {
  id: string;
  apps: readonly string[];
  systems: readonly string[];
  modulePath: string;
  present: boolean;
  /** The host records where the module is. It does not compile it. */
  compiled: false;
}

/**
 * A player is a wasm file another app can load. Describing it must not
 * instantiate the module: a crafted wasm file would otherwise run inside the
 * process that can also see connector credentials.
 */
export async function describePlayer(
  directory: string,
  manifest: PluginManifest,
): Promise<PlayerDescription> {
  const player = manifest.player;
  if (!player) throw new PluginError('invalid-manifest', 'describePlayer requires a player plugin');
  const modulePath = pluginFile(directory, player.module);
  let present = false;
  try {
    present = (await stat(modulePath)).isFile();
  } catch {
    present = false;
  }
  return {
    id: manifest.id,
    apps: manifest.apps,
    systems: player.systems,
    modulePath,
    present,
    compiled: false,
  };
}
