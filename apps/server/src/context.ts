import type { RateLimiter } from '@ecs/auth';
import type { CatalogDatabase } from '@ecs/database';
import type { VirtualProviderRegistry } from '@ecs/storage';

export interface ServerContext {
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
