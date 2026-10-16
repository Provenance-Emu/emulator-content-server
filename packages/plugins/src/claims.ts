import { PluginError } from './errors.js';

/**
 * A free-account profile signs the app under an identifier derived from the
 * real one. That suffix is still this developer's app. A different bundle is not.
 */
export function claims(apps: readonly string[], bundleId: string): boolean {
  return apps.some((app) => bundleId === app || bundleId.startsWith(`${app}.`));
}

export function assertClaims(apps: readonly string[], bundleId: string): void {
  if (!claims(apps, bundleId)) {
    throw new PluginError(
      'app-not-claimed',
      `${bundleId} is not an app this plugin is allowed to publish`,
    );
  }
}
