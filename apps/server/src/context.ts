import type { RateLimiter } from '@ecs/auth';
import type { CatalogDatabase } from '@ecs/database';
import type { VirtualProviderRegistry } from '@ecs/storage';
import type { PlayerAssets } from './player-assets.js';
import type { PlayerManager } from './player-manager.js';
import type { PlayerProfileAssets } from './player-profiles.js';

export interface ServerContext {
  playerManager?: PlayerManager;
  player?: PlayerAssets;
  playerProfiles: ReadonlyMap<string, PlayerProfileAssets>;
  defaultPlayerProfileId: string | null;
  matchingPluginsDir?: string;
  matchingTools?: { sevenZip?: string; chdman?: string };
  catalog: CatalogDatabase;
  dataDir: string;
  webdavEnabled: boolean;
  displayName: string;
  virtual: VirtualProviderRegistry;
  limiter: RateLimiter;
  /** Built web assets to serve under `/ui`, or null to serve no interface. */
  uiDir: string | null;
  /**
   * When false, every request needs a token. Set for a server that was started
   * facing the public internet, where the socket address is the proxy.
   */
  localTrust: boolean;
}
