import { ICLOUD_CONTAINER, type IcloudOptions } from './icloud.js';

/**
 * The API token for the apps' production iCloud container, so a household sets nothing up.
 *
 * It names the application, not a person, and is the kind of value Apple expects a web page to
 * carry in the open. It reads nothing by itself: reading a person's saves also takes their own
 * Apple sign-in, which the server holds in memory and never stores. Empty means no default, and
 * iCloud saves are then offered only when the operator supplies a token.
 */
// biome-ignore format: kept on one line so scripts/set-icloud-default-token.sh can find it
export const ICLOUD_DEFAULT_API_TOKEN = 'a25162c6cc47baeab22a4092f0246d0e6882525423754788b47cd0c5d522f602';

/**
 * What the operator's environment asks for. `ECS_ICLOUD_API_TOKEN=off` turns the feature off.
 * The built-in token belongs to the production database of the apps' own container, so it is
 * not used when another container or the development database is selected.
 */
export function icloudSettings(
  env: Record<string, string | undefined>,
  builtIn: string = ICLOUD_DEFAULT_API_TOKEN,
): IcloudOptions | undefined {
  const supplied = env.ECS_ICLOUD_API_TOKEN?.trim();
  if (supplied?.toLowerCase() === 'off') return undefined;
  const container = env.ECS_ICLOUD_CONTAINER?.trim() || undefined;
  const development = env.ECS_ICLOUD_ENVIRONMENT === 'development';
  const fits = !development && (!container || container === ICLOUD_CONTAINER);
  const apiToken = supplied || (fits ? builtIn.trim() : '');
  if (!apiToken) return undefined;
  return {
    apiToken,
    ...(container ? { container } : {}),
    ...(development ? { environment: 'development' as const } : {}),
  };
}
