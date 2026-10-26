import { authorize } from '@ecs/auth';
import {
  type Actor,
  type AssetRecord,
  type ContentRootRecord,
  DomainError,
  type ItemRecord,
  type SourceFileRecord,
} from '@ecs/domain';
import { isRestrictedAssetKind, strongEtag, validateAssetKind } from '@ecs/protocol';
import { probeRoot, resolveInside } from '@ecs/storage';
import { type DavNamespace, type DavResource, parseDavPath } from '@ecs/webdav';
import type { ServerContext } from './context.js';
import { sourceMetadata } from './source-metadata.js';

interface SourceNode {
  source?: SourceFileRecord;
  ambiguous: boolean;
  children: Set<string>;
}

function tooLarge(): never {
  throw new DomainError('quota-exceeded', 507, 'Collection is too large');
}
function filename(id: string, displayName: string): string {
  const safe = Buffer.from(displayName, 'utf8')
    .toString('utf8')
    .normalize('NFC')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject XML-invalid or unsafe path characters
    .replace(/[/\\:%\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+$/, '_');
  return `${id}--${safe || 'file'}`;
}
export function createDavNamespace(context: ServerContext, actor: Actor): DavNamespace {
  const { catalog } = context;
  let visited = 0;
  const itemCache = new Map<string, ItemRecord[]>();
  const probes = new Map<string, ReturnType<typeof probeRoot>>();
  const sourceIndexes = new Map<string, Map<string, SourceNode>>();
  const collection = (segments: string[], displayName: string): DavResource => ({
    segments,
    displayName,
    kind: 'collection',
  });
  const membership = (libraryId: string) =>
    actor.kind === 'user' ? catalog.membership(actor.userId, libraryId) : null;
  const itemRead = (item: ItemRecord, asset?: AssetRecord) => {
    if (actor.kind === 'guest' && asset && isRestrictedAssetKind(asset.kind)) return false;
    return authorize({
      actor,
      action: 'read',
      libraryId: item.libraryId,
      itemId: item.id,
      membership: membership(item.libraryId),
      itemPermissions: actor.kind === 'user' ? catalog.itemPermissions(actor.userId, item.id) : [],
      ...(asset ? { assetKind: asset.kind, shareable: asset.shareable } : {}),
    });
  };
  const libraryRead = (id: string) =>
    authorize({ actor, action: 'read', libraryId: id, membership: membership(id) });
  function items(libraryId: string): ItemRecord[] {
    const cached = itemCache.get(libraryId);
    if (cached) return cached;
    if (actor.kind === 'user' && !actor.scopes.includes('read')) return [];
    let afterId: string | null = null;
    const result: ItemRecord[] = [];
    do {
      const page = catalog.listItems({
        libraryId,
        afterId,
        limit: 100,
        itemId: actor.kind === 'guest' ? actor.itemId : null,
        readableByUserId:
          actor.kind === 'user' && !libraryRead(libraryId) ? actor.userId : undefined,
      });
      for (const item of page.items) {
        if (++visited > 10000) tooLarge();
        if (itemRead(item)) result.push(item);
      }
      afterId = page.nextCursor;
    } while (afterId);
    itemCache.set(libraryId, result);
    return result;
  }
  function rootRead(root: ContentRootRecord): boolean {
    if (actor.kind === 'guest' && actor.itemId) return false;
    if (actor.kind === 'user' && !actor.scopes.includes('read')) return false;
    if (actor.kind === 'user' && actor.isOwner) return true;
    return root.libraryId !== null && libraryRead(root.libraryId);
  }
  function sourceIndex(rootId: string): Map<string, SourceNode> {
    const cached = sourceIndexes.get(rootId);
    if (cached) return cached;
    // SQL bounds allocation, including the extra row that detects overflow.
    const sources = catalog.listSources(rootId, 10001);
    if (sources.length > 10000) tooLarge();
    const index = new Map<string, SourceNode>();
    const node = (key: string) => {
      let value = index.get(key);
      if (!value) {
        if (index.size >= 10000) tooLarge();
        value = { ambiguous: false, children: new Set<string>() };
        index.set(key, value);
      }
      return value;
    };
    node('');
    for (const source of sources) {
      if (++visited > 10000) tooLarge();
      const kind = validateAssetKind(source.kind);
      if (actor.kind === 'guest' && kind && isRestrictedAssetKind(kind)) continue;
      let parts: string[];
      try {
        parts = parseDavPath(
          `/dav/${source.relativePath.split('/').map(encodeURIComponent).join('/')}`,
        );
      } catch {
        continue;
      }
      let key = '';
      for (const part of parts) {
        node(key).children.add(part);
        key = key ? `${key}/${part}` : part;
        node(key);
      }
      const leaf = node(key);
      if (leaf.source) leaf.ambiguous = true;
      leaf.source = source;
    }
    sourceIndexes.set(rootId, index);
    return index;
  }
  async function resolve(segments: string[]): Promise<DavResource | null> {
    const [area, libraryOrRoot, itemId, leaf] = segments;
    if (!area) return collection([], 'Emulation Server');
    if (!['libraries', 'sources'].includes(area)) return null;
    if (!libraryOrRoot) return collection([area], area === 'libraries' ? 'Libraries' : 'Sources');
    if (area === 'libraries') {
      const library = catalog.getLibrary(libraryOrRoot);
      if (!library) return null;
      if (!itemId)
        return libraryRead(library.id) || items(library.id).length > 0
          ? collection(segments, library.name)
          : null;
      const item = catalog.getItem(itemId);
      if (!item || item.libraryId !== library.id || !itemRead(item)) return null;
      if (!leaf) return collection(segments, item.title);
      if (segments.length !== 4) return null;
      const assetId = leaf.slice(0, 36);
      const asset = catalog.getAsset(assetId);
      if (
        !asset ||
        asset.itemId !== item.id ||
        !itemRead(item, asset) ||
        filename(asset.id, asset.displayName) !== leaf
      )
        return null;
      return {
        segments,
        displayName: asset.displayName,
        kind: 'asset',
        id: asset.id,
        size: asset.size,
        etag: strongEtag(asset.sha256),
        createdAt: asset.createdAt,
        modifiedAt: asset.updatedAt,
      };
    }
    const root = catalog.getContentRoot(libraryOrRoot);
    if (!root || !rootRead(root)) return null;
    if (segments.length === 2) return collection(segments, root.label);
    const rest = segments.slice(2);
    const node = sourceIndex(root.id).get(rest.join('/'));
    if (!node) return null;
    const directory = node.children.size > 0;
    if (node.ambiguous || (node.source && directory))
      throw new DomainError('conflict', 409, 'Ambiguous source name');
    const source = node.source;
    if (source) {
      let size = source.size;
      let modifiedAt: string | undefined;
      let etag: string | undefined;
      try {
        const full = await resolveInside(root.path, source.relativePath, { pinnedRoot: true });
        if (!probes.has(root.id)) probes.set(root.id, probeRoot(root.path));
        if ((await probes.get(root.id))?.online) {
          const metadata = await sourceMetadata(full, source.id);
          size = metadata.size;
          modifiedAt = metadata.modifiedAt;
          etag = metadata.etag;
        }
      } catch {
        /* Preserve catalog metadata offline; content reads recheck presence. */
      }
      return {
        segments,
        displayName: source.displayName,
        kind: 'source',
        id: source.id,
        size,
        etag,
        modifiedAt,
      };
    }
    return directory ? collection(segments, rest.at(-1) ?? root.label) : null;
  }
  async function children(resource: DavResource): Promise<DavResource[]> {
    const segments = resource.segments;
    let paths: string[][] = [];
    if (segments.length === 0) paths = [['libraries'], ['sources']];
    else if (segments[0] === 'libraries') {
      if (segments.length === 1) {
        const candidates =
          actor.kind === 'guest'
            ? [catalog.getLibrary(actor.libraryId)].filter((v) => v !== null)
            : catalog.listLibraries(actor.userId, true);
        for (const library of candidates) {
          if (libraryRead(library.id) || items(library.id).length)
            paths.push(['libraries', library.id]);
        }
      } else if (segments.length === 2)
        paths = items(segments[1] ?? '').map((item) => [...segments, item.id]);
      else if (segments.length === 3) {
        const item = catalog.getItem(segments[2] ?? '');
        if (item)
          paths = (catalog.manifest(item.id)?.files ?? [])
            .filter((asset) => itemRead(item, asset))
            .map((asset) => [...segments, filename(asset.id, asset.displayName)]);
      }
    } else if (segments[0] === 'sources') {
      if (segments.length === 1)
        paths = catalog
          .listContentRoots()
          .filter(rootRead)
          .map((root) => ['sources', root.id]);
      else {
        const node = sourceIndex(segments[1] ?? '').get(segments.slice(2).join('/'));
        paths = [...(node?.children ?? [])].map((name) => [...segments, name]);
      }
    }
    if (paths.length > 10000) tooLarge();
    const result: DavResource[] = [];
    for (const path of paths) {
      const entry = await resolve(path);
      if (entry) result.push(entry);
    }
    return result;
  }
  return { resolve, children };
}
