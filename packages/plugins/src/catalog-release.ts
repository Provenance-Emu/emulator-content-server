import type { HostedCatalogPin } from './hosted-catalog.js';

/** Verified immutable public catalog release; never replace assets at this tag. */
export const HOSTED_CATALOG_PIN: HostedCatalogPin | null = {
  url: 'https://github.com/Provenance-Emu/emulator-content-server/releases/download/catalog-2026.10.30.1/index.json',
  sha256: '5e0d851b90b42e278369d96a46ee6cf766d64063f4c30b5af812424a2eab0e9b',
  bytes: 19007,
  release: 'catalog-2026.10.30.1',
};
