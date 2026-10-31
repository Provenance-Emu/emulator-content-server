import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js/index-native.js';
import { convertDelta } from './delta.js';
import { pngSize } from './png.js';
import { type SkinAsset, type SkinPackage, skinLimits } from './types.js';

function path(name: string) {
  if (
    !name ||
    name.length > 240 ||
    name.includes('\\') ||
    [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    name.startsWith('/') ||
    name.includes(':') ||
    name.split('/').some((p) => p === '.' || p === '..' || !p)
  )
    throw Error('Unsafe archive path');
  return name.normalize('NFC');
}
export async function readSkinArchive(
  bytes: Uint8Array,
  signal?: AbortSignal,
  progress?: (n: number) => void,
): Promise<SkinPackage> {
  if (!bytes.length || bytes.length > skinLimits.archive)
    throw Error('Archive byte limit exceeded');
  signal?.throwIfAborted();
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
    strictness: 'strict',
    checkSignature: true,
  });
  try {
    const entries: Awaited<ReturnType<typeof reader.getEntries>> = [];
    for await (const e of reader.getEntriesGenerator()) {
      entries.push(e);
      if (entries.length > skinLimits.entries) throw Error('Archive entry limit exceeded');
    }
    if (!entries.length || entries.length > skinLimits.entries)
      throw Error('Archive entry limit exceeded');
    const names = new Set<string>();
    let declared = 0;
    for (const e of entries) {
      const n = path(e.directory ? e.filename.replace(/\/$/, '') : e.filename).toLowerCase();
      if (names.has(n)) throw Error('Ambiguous archive names');
      names.add(n);
      if (/\.(zip|deltaskin|7z|rar)$/i.test(e.filename))
        throw Error('Nested archives are not supported');
      if (e.encrypted || e.symlink || ![0, 8].includes(e.compressionMethod))
        throw Error('Unsupported encrypted, linked or compressed archive entry');
      declared += e.uncompressedSize;
      if (
        !Number.isSafeInteger(e.compressedSize) ||
        e.compressedSize < 0 ||
        e.compressedSize > skinLimits.archive ||
        !Number.isSafeInteger(e.uncompressedSize) ||
        e.uncompressedSize < 0 ||
        e.uncompressedSize > skinLimits.asset ||
        declared > skinLimits.expanded ||
        e.uncompressedSize > Math.max(e.compressedSize, 1) * skinLimits.ratio
      )
        throw Error('Expanded archive size limit exceeded');
    }
    const files = new Map<string, Uint8Array>();
    let expanded = 0;
    for (const [i, e] of entries.entries()) {
      signal?.throwIfAborted();
      if (e.directory) continue;
      const cap = e.filename.toLowerCase().endsWith('info.json')
        ? skinLimits.info
        : skinLimits.asset;
      const data = await e.getData(new Uint8ArrayWriter(), {
        useWebWorkers: false,
        signal,
        checkSignature: true,
        onprogress(n) {
          if (n > cap || expanded + n > skinLimits.expanded)
            throw Error('Extracted byte limit exceeded');
        },
      });
      if (!data || data.length > cap || data.length !== e.uncompressedSize)
        throw Error('Extracted size mismatch');
      expanded += data.length;
      files.set(path(e.filename), data);
      progress?.((i + 1) / entries.length);
    }
    const infos = [...files.keys()].filter(
      (n) => n.toLowerCase() === 'info.json' || n.toLowerCase().endsWith('/info.json'),
    );
    if (infos.length !== 1) throw Error('Expected one info.json');
    const infoPath = infos[0]!,
      root = infoPath.slice(0, -9);
    const info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.get(infoPath)));
    const assets: SkinAsset[] = [];
    const resolved = new Map<string, SkinAsset>();
    const resolve = (name: string) => {
      path(name);
      const exact = root + name;
      let matches = files.has(exact)
        ? [exact]
        : [...files.keys()].filter((p) => p.toLowerCase() === exact.toLowerCase());
      if (!matches.length) {
        const stem = name
          .split('/')
          .at(-1)
          ?.replace(/\.[^.]+$/, '')
          .toLowerCase();
        matches = [...files.keys()].filter(
          (p) =>
            p.startsWith(root) &&
            p
              .split('/')
              .at(-1)
              ?.replace(/\.[^.]+$/, '')
              .toLowerCase() === stem,
        );
      }
      if (matches.length !== 1) throw Error('Missing or ambiguous artwork: ' + name);
      const p = matches[0]!,
        cached = resolved.get(p);
      if (cached) return cached;
      if (assets.length >= skinLimits.assets) throw Error('Artwork count limit exceeded');
      const data = files.get(p)!;
      const pdf = new TextDecoder().decode(data.slice(0, 8)).startsWith('%PDF-');
      if (!pdf) pngSize(data);
      const asset: SkinAsset = {
        id: 'asset-' + assets.length,
        name: p,
        mediaType: pdf ? 'application/pdf' : 'image/png',
        blob: new Blob([Uint8Array.from(data).buffer], {
          type: pdf ? 'application/pdf' : 'image/png',
        }),
      };
      assets.push(asset);
      resolved.set(p, asset);
      return asset;
    };
    const parsed = convertDelta(info, resolve),
      hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
    return {
      ...parsed,
      id: [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join(''),
      assets,
      original: new Blob([Uint8Array.from(bytes).buffer]),
      bytes: bytes.length + assets.reduce((n, a) => n + a.blob.size, 0),
      created: Date.now(),
    };
  } finally {
    await reader.close();
  }
}
