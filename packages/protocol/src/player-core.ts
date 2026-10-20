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
