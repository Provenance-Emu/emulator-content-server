import type { HostedCatalogPin } from './hosted-catalog.js';

/** Verified immutable public catalog release; never replace assets at this tag. */
export const HOSTED_CATALOG_PIN: HostedCatalogPin | null = {
  url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/catalog-2026.10.28.1/index.json',
  sha256: '5ff3e4be9e579f2b477b4e1483206ee3cd53178629dae3d9c168992ac4e77ab4',
  bytes: 18376,
  release: 'catalog-2026.10.28.1',
};
