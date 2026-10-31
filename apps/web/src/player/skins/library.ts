import { defaultLayout, validateLayout } from '../layout.js';
import { selectSkinLayout } from './delta.js';
import { type SkinPackage, type SkinPreference, skinLimits } from './types.js';
export function validateSkin(pkg: SkinPackage) {
  if (
    !pkg ||
    !/^[a-f0-9]{64}$/.test(pkg.id) ||
    typeof pkg.name !== 'string' ||
    pkg.name.length > 80 ||
    typeof pkg.system !== 'string' ||
    !Array.isArray(pkg.variants) ||
    !pkg.variants.length ||
    pkg.variants.length > 24 ||
    !Array.isArray(pkg.assets) ||
    pkg.assets.length > skinLimits.assets ||
    !(pkg.original instanceof Blob) ||
    pkg.original.size > skinLimits.archive
  )
    throw Error('Invalid stored skin');
  for (const a of pkg.assets)
    if (
      !(a.blob instanceof Blob) ||
      a.blob.size > skinLimits.asset ||
      !['image/png', 'application/pdf'].includes(a.mediaType)
    )
      throw Error('Invalid stored artwork');
  for (const v of pkg.variants) {
    const doc = defaultLayout();
    doc.assets = pkg.assets.map((a) => ({ id: a.id, mediaType: a.mediaType }));
    if (
      !['portrait', 'landscape'].includes(v.orientation) ||
      typeof v.key !== 'string' ||
      v.key.length > 130 ||
      !Array.isArray(v.issues) ||
      v.issues.some((s) => typeof s !== 'string' || s.length > 300) ||
      typeof v.live !== 'boolean'
    )
      throw Error('Invalid stored variant');
    doc.representations[v.orientation] = v.representation;
    validateLayout(doc);
  }
  return pkg;
}
export function validatePreference(p: SkinPreference, pkg?: SkinPackage) {
  if (
    !p ||
    typeof p.basis !== 'string' ||
    !(
      /^[a-f0-9]{64}$/.test(p.basis) || ['builtin-compact', 'builtin-standard'].includes(p.basis)
    ) ||
    !p.choices ||
    !p.overrides ||
    JSON.stringify(p).length > 131072
  )
    throw Error('Invalid skin preference');
  if (p.basis.startsWith('builtin-') && Object.keys(p.choices).length)
    throw Error('Unexpected built-in variants');
  for (const k of [...Object.keys(p.choices), ...Object.keys(p.overrides)])
    if (!['portrait', 'landscape'].includes(k)) throw Error('Invalid orientation');
  if (pkg) {
    if (pkg.id !== p.basis) throw Error('Skin basis mismatch');
    for (const o of ['portrait', 'landscape'] as const)
      if (p.choices[o] && !pkg.variants.some((v) => v.key === p.choices[o] && v.orientation === o))
        throw Error('Missing skin variant');
  } else if (!p.basis.startsWith('builtin-')) throw Error('Missing installed skin');
  const layout = pkg
    ? selectSkinLayout(pkg, p.choices).layout
    : defaultLayout(p.basis === 'builtin-standard' ? 'standard' : 'compact');
  for (const o of ['portrait', 'landscape'] as const)
    if (p.overrides[o]) layout.representations[o] = p.overrides[o]!;
  validateLayout(layout);
  return p;
}
type StoredSkin = Omit<SkinPackage, 'original' | 'assets'> & {
  encoding: 'bytes-v1';
  original: ArrayBuffer;
  assets: (Omit<SkinPackage['assets'][number], 'blob'> & { blob: ArrayBuffer })[];
};
function hydrate(record: SkinPackage | StoredSkin): SkinPackage {
  if ('encoding' in record && record.encoding === 'bytes-v1')
    return {
      ...record,
      original: new Blob([record.original]),
      assets: record.assets.map((a) => ({ ...a, blob: new Blob([a.blob], { type: a.mediaType }) })),
    };
  return record as SkinPackage;
}
export class SkinLibrary {
  private db: Promise<IDBDatabase> | null = null;
  private closed = false;
  constructor(
    private name = 'ecs.skin-library.v1',
    private factory?: IDBFactory,
  ) {}
  private open() {
    if (this.closed) return Promise.reject<IDBDatabase>(Error('Skin library is closed'));
    if (!this.db)
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const factory = this.factory ?? globalThis.indexedDB;
        if (!factory) {
          reject(Error('Local skin storage is unavailable'));
          return;
        }
        const r = factory.open(this.name, 1);
        r.onupgradeneeded = () => {
          for (const s of ['skins', 'preferences', 'cache'])
            if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
        };
        r.onerror = () => reject(r.error ?? Error('Local skin storage failed'));
        r.onblocked = () => reject(Error('Close another player tab to update skin storage'));
        r.onsuccess = () => {
          r.result.onversionchange = () => {
            r.result.close();
            this.db = null;
          };
          resolve(r.result);
        };
      });
    return this.db;
  }
  private async run<T>(
    stores: string[],
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction, done: (value: T) => void) => void,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = (event) =>
        reject(
          tx.error ?? (event.target as IDBRequest)?.error ?? Error('Local skin transaction failed'),
        );
      tx.onabort = () => reject(tx.error ?? Error('Local skin transaction was cancelled'));
      try {
        fn(tx, (v) => {
          value = v;
        });
      } catch (e) {
        tx.abort();
        reject(e);
      }
    });
  }
  async list() {
    const all = await this.run<(SkinPackage | StoredSkin)[]>(['skins'], 'readonly', (tx, done) => {
      const r = tx.objectStore('skins').getAll();
      r.onsuccess = () => done(r.result);
    });
    return all
      .flatMap((record) => {
        try {
          return [validateSkin(hydrate(record))];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.created - a.created);
  }
  async get(id: string) {
    const p = await this.run<SkinPackage | StoredSkin | undefined>(
      ['skins'],
      'readonly',
      (tx, done) => {
        const r = tx.objectStore('skins').get(id);
        r.onsuccess = () => done(r.result);
      },
    );
    return p ? validateSkin(hydrate(p)) : undefined;
  }
  async put(pkg: SkinPackage) {
    validateSkin(pkg);
    const bytes =
      pkg.original.size +
      pkg.assets.reduce((n, a) => n + a.blob.size, 0) +
      new Blob([
        JSON.stringify({ ...pkg, assets: pkg.assets.map(({ blob, ...a }) => a), original: null }),
      ]).size;
    // ArrayBuffers avoid WebKit's Blob/File preparation failure in IndexedDB.
    // Complete reads before opening the transaction so it cannot become inactive.
    const stored: StoredSkin = {
      ...pkg,
      bytes,
      encoding: 'bytes-v1',
      original: await pkg.original.arrayBuffer(),
      assets: await Promise.all(
        pkg.assets.map(async (a) => ({ ...a, blob: await a.blob.arrayBuffer() })),
      ),
    };
    return this.run<void>(['skins'], 'readwrite', (tx, done) => {
      const store = tx.objectStore('skins'),
        r = store.getAll();
      r.onsuccess = () => {
        const other = (r.result as SkinPackage[]).filter((p) => p.id !== pkg.id);
        if (
          other.length >= skinLimits.installed ||
          other.reduce((n, p) => n + p.bytes, 0) + bytes > skinLimits.library
        ) {
          tx.abort();
          return;
        }
        store.put(stored, pkg.id);
        done();
      };
    });
  }
  async remove(id: string) {
    await this.run<void>(['skins'], 'readwrite', (tx, done) => {
      tx.objectStore('skins').delete(id);
      done();
    });
  }
  async getPreference(key: string) {
    return this.run<SkinPreference | undefined>(['preferences'], 'readonly', (tx, done) => {
      const r = tx.objectStore('preferences').get(key);
      r.onsuccess = () => done(r.result);
    });
  }
  async putPreference(key: string, p: SkinPreference) {
    return this.run<void>(['skins', 'preferences'], 'readwrite', (tx, done) => {
      const write = (pkg?: SkinPackage) => {
        try {
          validatePreference(p, pkg);
          tx.objectStore('preferences').put(p, key);
          done();
        } catch (e) {
          tx.abort();
        }
      };
      if (p.basis.startsWith('builtin-')) write();
      else {
        const r = tx.objectStore('skins').get(p.basis);
        r.onsuccess = () => write(r.result ? hydrate(r.result) : undefined);
      }
    }).catch(() => {
      throw Error(
        'Skin selection could not be saved: missing skin, storage limit or unavailable storage.',
      );
    });
  }
  async clearPreference(key: string) {
    await this.run<void>(['preferences'], 'readwrite', (tx, done) => {
      tx.objectStore('preferences').delete(key);
      done();
    });
  }
  async getCatalog() {
    return this.run<{ text: string; time: number } | undefined>(
      ['cache'],
      'readonly',
      (tx, done) => {
        const r = tx.objectStore('cache').get('catalog');
        r.onsuccess = () => done(r.result);
      },
    );
  }
  async putCatalog(v: { text: string; time: number }) {
    if (new TextEncoder().encode(v.text).length > 2 * 1024 * 1024)
      throw Error('Catalog cache limit exceeded');
    await this.run<void>(['cache'], 'readwrite', (tx, done) => {
      tx.objectStore('cache').put(v, 'catalog');
      done();
    });
  }
  close() {
    this.closed = true;
    void this.db?.then(
      (db) => db.close(),
      () => {},
    );
    this.db = null;
  }
}
