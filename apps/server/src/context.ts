import type { RateLimiter } from '@ecs/auth';
import type { CatalogDatabase } from '@ecs/database';
import type { VirtualProviderRegistry } from '@ecs/storage';

export interface ServerContext {
  catalog: CatalogDatabase;
  dataDir: string;
  displayName: string;
  virtual: VirtualProviderRegistry;
  limiter: RateLimiter;
  /** Built web assets to serve under `/ui`, or null to serve no interface. */
  uiDir: string | null;
}
