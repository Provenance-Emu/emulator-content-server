/** Public browser core metadata. Artifact URLs are fixed same-origin resources. */
export interface PlayerCoreResource {
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface PlayerCoreDescriptor {
  version: number;
  id: string;
  name: string;
  systems: string[];
  runtime: string;
  threaded: boolean;
  filesystem: string;
  saveCompletion: string;
  frontendCommit: string;
  coreCommit: string;
  emscriptenVersion: string;
  contentExtension: string;
  maxContentBytes: number;
  loader: PlayerCoreResource;
  wasm: PlayerCoreResource;
}

/** Portable browser runtime contract. No operator filesystem paths are exposed. */
export interface WebPlayerAsset extends PlayerCoreResource {
  name: string;
}
export interface WebPlayerDescriptor {
  profileVersion: number;
  id: string;
  name: string;
  systems: string[];
  runtime: string;
  filesystem: string;
  threaded: boolean;
  saveCompletion: string;
  contentExtensions: string[];
  maxContentBytes: number;
  buildVersion: string;
  loader: PlayerCoreResource;
  wasm: PlayerCoreResource;
  assets: WebPlayerAsset[];
}
export interface WebPlayerCatalog {
  items: WebPlayerDescriptor[];
  defaultProfileId: string | null;
}

export interface PlayerConfiguration {
  enabled?: boolean;
  default?: boolean;
}
export interface PlayerInstallation {
  profile: WebPlayerDescriptor;
  enabled: boolean;
  source: 'managed' | 'operator';
  removable: boolean;
}
export interface PlayerCatalogEntry {
  id: string;
  name: string;
  systems: string[];
  description: string;
  available: boolean;
  reason: string | null;
  downloadBytes: number | null;
}
export interface PlayerManagement {
  items: PlayerInstallation[];
  defaultProfileId: string | null;
  available: PlayerCatalogEntry[];
}

export interface PlayerIsolationDraft {
  profileId: string;
}

/** Ephemeral local browser bootstrap. Contains no content or authentication credentials. */
export interface PlayerIsolationSession {
  id: string;
  url: string;
  expiresAt: string;
}
