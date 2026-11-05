import { boundedFetch, safeExternalUrl } from './network.js';
import { skinSystem } from './types.js';
export interface CatalogEntry {
  id: string;
  name: string;
  author: string;
  systems: string[];
  downloadURL: string;
  thumbnailURL: string | null;
  format: 'delta' | 'other';
}
export interface SkinCatalog {
  entries: CatalogEntry[];
  dropped: number;
}
export interface CatalogCache {
  getCatalog(): Promise<{ text: string; time: number } | undefined>;
  putCatalog(v: { text: string; time: number }): Promise<void>;
}
export function parseCatalog(text: string): SkinCatalog {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024)
    throw Error('Catalog byte limit exceeded');
  const v = JSON.parse(text);
  if (!v || !Array.isArray(v.skins) || v.skins.length > 5000) throw Error('Invalid skin catalog');
  const entries: CatalogEntry[] = [];
  let dropped = 0;
  const ids = new Set<string>();
  for (const s of v.skins) {
    try {
      if (
        !s ||
        typeof s.id !== 'string' ||
        !s.id ||
        s.id.length > 120 ||
        ids.has(s.id) ||
        typeof s.name !== 'string' ||
        !s.name ||
        s.name.length > 160 ||
        typeof s.downloadURL !== 'string' ||
        !Array.isArray(s.systems) ||
        s.systems.length > 20
      )
        throw Error();
      const downloadURL = safeExternalUrl(s.downloadURL),
        systems = s.systems
          .filter((x: unknown) => typeof x === 'string' && x.length <= 100)
          .map(skinSystem);
      if (!systems.length) throw Error();
      ids.add(s.id);
      let thumbnailURL: string | null = null;
      try {
        if (s.thumbnailURL) thumbnailURL = safeExternalUrl(s.thumbnailURL);
      } catch {}
      entries.push({
        id: s.id,
        name: s.name,
        author: typeof s.author === 'string' ? s.author.slice(0, 120) : 'Unknown author',
        systems,
        downloadURL,
        thumbnailURL,
        format: new URL(downloadURL).pathname.toLowerCase().endsWith('.deltaskin')
          ? 'delta'
          : 'other',
      });
    } catch {
      dropped++;
    }
  }
  return { entries, dropped };
}
export function thumbnailUrl(e: CatalogEntry): string | null {
  if (!e.thumbnailURL) return null;
  const u = new URL(e.thumbnailURL),
    m = /^\/Provenance-Emu\/skins\/releases\/download\/thumbnails\/([a-f0-9]{16})\.png$/.exec(
      u.pathname,
    );
  if (u.hostname === 'github.com' && m)
    return `https://raw.githubusercontent.com/Provenance-Emu/skins/main/thumbnails/${m[1]}.png`;
  if (
    u.hostname === 'raw.githubusercontent.com' &&
    /^\/Provenance-Emu\/skins\/main\/thumbnails\/[a-f0-9]{16}\.png$/.test(u.pathname)
  )
    return u.href;
  return null;
}
export function catalogPage(
  c: SkinCatalog,
  query: string,
  system: string,
  format: string,
  page: number,
) {
  const q = query.trim().toLowerCase().slice(0, 160),
    all = c.entries.filter(
      (e) =>
        (!system || e.systems.includes(skinSystem(system))) &&
        (format !== 'delta' || e.format === 'delta') &&
        (!q || (e.name + ' ' + e.author).toLowerCase().includes(q)),
    );
  const pages = Math.max(1, Math.ceil(all.length / 50)),
    index = Math.max(0, Math.min(pages - 1, Math.floor(page) || 0));
  return { items: all.slice(index * 50, index * 50 + 50), total: all.length, page: index, pages };
}
export async function loadCatalog(
  cache: CatalogCache,
  force = false,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
) {
  let stored: { text: string; time: number } | undefined;
  try {
    stored = await cache.getCatalog();
    if (stored && !force && now >= stored.time && now - stored.time < 86400000)
      return { catalog: parseCatalog(stored.text), stale: false, warning: null as string | null };
  } catch {
    stored = undefined;
  }
  for (const url of [
    'https://emuskins.com/catalog.json',
    'https://raw.githubusercontent.com/Provenance-Emu/skins/main/catalog.json',
  ])
    try {
      const bytes = await boundedFetch(url, 2 * 1024 * 1024, signal, fetcher),
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        catalog = parseCatalog(text);
      let warning: string | null = null;
      try {
        await cache.putCatalog({ text, time: now });
      } catch {
        warning = 'Catalog loaded, but offline caching is unavailable.';
      }
      return { catalog, stale: false, warning };
    } catch (error) {
      signal?.throwIfAborted();
    }
  if (stored)
    return {
      catalog: parseCatalog(stored.text),
      stale: true,
      warning: 'Offline: showing the previously cached catalog.',
    };
  throw Error('The skin catalog is unavailable. Local import still works.');
}
