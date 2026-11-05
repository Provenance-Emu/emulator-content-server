import { isAbsolute } from 'node:path';

export interface PlayerCatalogSelection {
  file: string;
  id: string;
}

export function playerCatalogSelection(
  file: string | undefined,
  id: string | undefined,
): PlayerCatalogSelection | undefined {
  if (file === undefined && id === undefined) return undefined;
  if (!file || !isAbsolute(file) || !id || !/^[a-f0-9]{64}$/.test(id))
    throw new Error(
      '--player-catalog requires an absolute file path and --player-catalog-id requires its SHA-256 snapshot ID',
    );
  return { file, id };
}
