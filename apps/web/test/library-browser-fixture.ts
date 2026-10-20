import {
  type Asset,
  ContentClient,
  type Item,
  type LibraryBrowseEntry,
  type ManifestFile,
} from '@ecs/client';
export const item = (id = 'item'): Item => ({
  id,
  libraryId: 'library',
  systemIdentifier: 'com.provenance.nes',
  title: 'Same title',
  revision: 7,
  md5: null,
  crc: null,
  createdAt: '',
  updatedAt: '',
});
export const asset = (id = 'asset', kind = 'battery_save'): Asset => ({
  id,
  itemId: 'item',
  kind,
  displayName: 'Same title',
  relativePath: 'folder/save.sav',
  sha256: 'a'.repeat(64),
  size: 3,
  md5: null,
  crc: null,
  shareable: true,
  revision: 2,
  createdAt: '',
  updatedAt: '',
  conflictOf: 'live',
});
export function entry(type = 'item', id = 'item'): LibraryBrowseEntry {
  const common = {
    entityType: type,
    id,
    name: 'Same title',
    libraryId: 'library',
    systemId: 'com.provenance.nes',
    canUpload: false,
    canAdopt: false,
  };
  if (type === 'item') return { ...common, item: item(id) };
  if (type === 'asset') return { ...common, asset: asset(id), parentItem: item() };
  return {
    ...common,
    source: {
      id,
      rootId: 'root',
      libraryId: 'library',
      name: 'Same title',
      kind: 'rom',
      size: 3,
      systemId: 'com.provenance.nes',
      availability: 'local',
      medium: 'local',
      contentPath: `/api/v1/sources/${encodeURIComponent(id)}/content`,
    },
  };
}
export const file = (id = 'live', conflictOf: string | null = null): ManifestFile => ({
  id,
  kind: 'battery_save',
  relativePath: conflictOf ? 'folder/save.sav.conflict-1234abcd' : 'folder/save.sav',
  sha256: 'a'.repeat(64),
  size: 3,
  md5: null,
  crc: null,
  required: false,
  contentPath: `/api/v1/files/${id}/content`,
  conflictOf,
});
export function transport(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  const previous = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    return handler(url, init);
  };
  return {
    client: new ContentClient('http://server.test'),
    requests,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}
export const problem = (status: number, code = 'unavailable') =>
  Response.json(
    { type: `urn:ecs:problem:${code}`, title: code, status, detail: 'Generated failure' },
    { status },
  );
