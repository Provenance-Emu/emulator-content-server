import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlycastCatalog } from '../packages/plugins/dist/src/arcade-catalog.js';
import { normalizeCheats } from '../packages/plugins/dist/src/cheats.js';
import {
  HOSTED_CATALOG_LIMITS,
  validateHostedCatalogIndex,
  validateHostedCatalogShard,
} from '../packages/plugins/dist/src/hosted-catalog.js';
import { parseLibretroDat, patchFingerprint } from '../packages/plugins/dist/src/matching.js';
import { loadMetadataSnapshot } from './catalog-snapshot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = join(here, 'catalog-sources.json');
const outputRepo = 'https://github.com/Provenance-Emu/emulator-content-server';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha1 = (value) => createHash('sha1').update(value).digest('hex');
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');

function safeFile(root, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.startsWith('/') ||
    relativePath.includes('\\')
  )
    throw new Error(`Invalid source path: ${relativePath}`);
  const resolved = resolve(root, relativePath);
  if (!resolved.startsWith(`${resolve(root)}${sep}`))
    throw new Error(`Source path escapes root: ${relativePath}`);
  return resolved;
}
function rawUrl(repository, revision, relativePath) {
  const { hostname, pathname } = new URL(repository);
  if (hostname !== 'github.com') throw new Error('Expected a GitHub source repository');
  const ownerRepo = pathname.split('/').filter(Boolean).slice(0, 2);
  if (ownerRepo.length !== 2 || !/^[a-f0-9]{40}$/.test(revision))
    throw new Error('Invalid pinned repository revision');
  const path = relativePath.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${ownerRepo.join('/')}/${revision}/${path}`;
}
async function walk(root, relativeDirectory) {
  const directory = safeFile(root, relativeDirectory);
  const results = [];
  async function visit(path, relative) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child, childRelative);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.cht'))
        results.push(childRelative);
    }
  }
  await visit(directory, relativeDirectory);
  return results.sort();
}
async function readBounded(response, maxBytes, label) {
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes)
    throw new Error(`${label}: exceeds ${maxBytes} byte limit`);
  if (!response.body) throw new Error(`${label}: missing response body`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error(`${label}: exceeds ${maxBytes} byte limit`);
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, size);
}
function bytesOfJsonRecord(record) {
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}
function splitRecords(kind, systemId, release, records, limit) {
  const sorted = [...records].sort((a, b) => a.id.localeCompare(b.id));
  const parts = [];
  let current = [];
  let bytes = Buffer.byteLength(
    JSON.stringify({ version: 1, release, kind, systemId, records: [] }),
  );
  for (const record of sorted) {
    const nextBytes = bytes + (current.length ? 1 : 0) + bytesOfJsonRecord(record);
    if (current.length && nextBytes + 2 > limit) {
      parts.push(current);
      current = [];
      bytes = Buffer.byteLength(
        JSON.stringify({ version: 1, release, kind, systemId, records: [] }),
      );
    }
    const recordBytes = bytes + (current.length ? 1 : 0) + bytesOfJsonRecord(record);
    if (recordBytes + 2 > limit) throw new Error(`Single ${kind} record exceeds shard byte limit`);
    current.push(record);
    bytes = recordBytes;
  }
  if (current.length) parts.push(current);
  return parts;
}
function sourceRecord(definition, repository, revision) {
  return {
    id: definition.id,
    name: definition.name,
    url: definition.url ?? repository,
    revision: definition.revision ?? revision,
    license: definition.license,
    ...(definition.notice ? { notice: definition.notice } : {}),
  };
}
function titleFromPath(path) {
  return path
    .split('/')
    .at(-1)
    .replace(/\.cht$/i, '');
}

export async function buildCatalog({
  sourceRoot,
  snapshotRoot,
  config,
  release = config.release,
  fetcher = fetch,
  releaseRepository = outputRepo,
  limits = HOSTED_CATALOG_LIMITS,
}) {
  if (!sourceRoot) throw new Error('A pinned libretro source checkout is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(release ?? ''))
    throw new Error('Invalid release tag');
  const libretro = config.libretro;
  const revision = libretro.revision;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid libretro commit pin');
  const expectedRepo = 'https://github.com/libretro/libretro-database';
  if (libretro.repository !== expectedRepo)
    throw new Error('Unexpected libretro source repository');

  const sourceDefinitions = new Map(libretro.sources.map((source) => [source.id, source]));
  const usedSources = new Set();
  const groups = new Map();
  const excludedResources = [];
  const snapshots = [];
  const addRecord = (kind, systemId, record, identity) => {
    const key = `${kind}\0${systemId}`;
    const rows = groups.get(key) ?? new Map();
    const id = `${kind === 'metadata' ? 'meta' : kind}-${sha1(`${systemId}\0${identity}`).slice(0, 40)}`;
    const prior = rows.get(id);
    if (prior) {
      prior.sourceIds = [...new Set([...prior.sourceIds, ...record.sourceIds])].sort();
    } else rows.set(id, { ...record, id });
    groups.set(key, rows);
  };

  for (const input of libretro.metadataFiles) {
    const source = sourceDefinitions.get(input.sourceId);
    if (!source) throw new Error(`Unknown metadata source ${input.sourceId}`);
    const bytes = await readFile(safeFile(sourceRoot, input.path));
    if (bytes.byteLength > 16 * 1024 * 1024)
      throw new Error(`DAT exceeds parser limit: ${input.path}`);
    const parsed = parseLibretroDat(bytes.toString('utf8'));
    for (const fact of parsed) {
      const identity = JSON.stringify([
        fact.title,
        fact.name,
        fact.size,
        fact.crc32,
        fact.md5,
        fact.sha1,
        fact.serials,
        fact.setIds,
        fact.media,
      ]);
      addRecord(
        'metadata',
        input.systemId,
        { ...fact, systemId: input.systemId, source: source.name, sourceIds: [input.sourceId] },
        identity,
      );
      usedSources.add(input.sourceId);
    }
  }

  for (const snapshot of config.metadataSnapshots ?? []) {
    if (sourceDefinitions.has(snapshot.sourceId))
      throw new Error('Duplicate metadata snapshot source');
    const loaded = await loadMetadataSnapshot(snapshot, { fetcher, snapshotRoot });
    sourceDefinitions.set(snapshot.sourceId, {
      id: snapshot.sourceId,
      name: snapshot.sourceName,
      url: snapshot.url,
      revision: snapshot.revision,
      license: snapshot.license,
      notice: snapshot.notice,
    });
    for (const fact of loaded.records) {
      const identity = JSON.stringify([
        fact.title,
        fact.name,
        fact.size,
        fact.crc32,
        fact.md5,
        fact.sha1,
      ]);
      addRecord(
        'metadata',
        snapshot.systemId,
        {
          ...fact,
          systemId: snapshot.systemId,
          source: snapshot.sourceName,
          sourceIds: [snapshot.sourceId],
        },
        identity,
      );
    }
    usedSources.add(snapshot.sourceId);
    snapshots.push({ definition: snapshot, ...loaded });
  }

  const flycast = config.flycast;
  const flycastUrl = rawUrl(flycast.repository, flycast.revision, flycast.path);
  const flycastBytes = await readBounded(
    await fetcher(flycastUrl, { redirect: 'error', credentials: 'omit' }),
    4 * 1024 * 1024,
    flycast.sourceName,
  );
  if (flycastBytes.byteLength !== flycast.bytes || sha256(flycastBytes) !== flycast.sha256)
    throw new Error('Pinned Flycast catalog identity mismatch');
  const flycastSource = {
    id: flycast.sourceId,
    name: flycast.sourceName,
    url: flycast.repository,
    revision: flycast.revision,
    license: flycast.license,
    notice: flycast.notice,
  };
  sourceDefinitions.set(flycast.sourceId, flycastSource);
  for (const fact of parseFlycastCatalog(flycastBytes.toString('utf8'))) {
    const identity = JSON.stringify([
      fact.title,
      fact.name,
      fact.size,
      fact.crc32,
      fact.md5,
      fact.sha1,
      fact.serials,
      fact.setIds,
      fact.media,
    ]);
    addRecord('metadata', fact.systemId, { ...fact, sourceIds: [flycast.sourceId] }, identity);
    usedSources.add(flycast.sourceId);
  }

  for (const folder of libretro.cheatFolders) {
    const paths = await walk(sourceRoot, folder.path);
    for (const path of paths) {
      const bytes = await readFile(safeFile(sourceRoot, path));
      if (!bytes.length || bytes.byteLength > limits.cheats) {
        excludedResources.push({
          path,
          bytes: bytes.byteLength,
          reason: !bytes.length
            ? 'empty source file'
            : `exceeds ${limits.cheats} byte hosted cheat limit`,
        });
        continue;
      }
      try {
        normalizeCheats(bytes);
      } catch (error) {
        excludedResources.push({
          path,
          bytes: bytes.byteLength,
          reason: `invalid RetroArch CHT: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      const title = titleFromPath(path);
      addRecord(
        'cheats',
        folder.systemId,
        {
          title,
          name: path.split('/').at(-1),
          systemId: folder.systemId,
          source: 'Libretro Database cheat file',
          sourceIds: ['libretro-cheats'],
          resource: {
            url: rawUrl(libretro.repository, revision, path),
            sha256: sha256(bytes),
            bytes: bytes.byteLength,
            format: 'retroarch-cht',
          },
        },
        path,
      );
      usedSources.add('libretro-cheats');
    }
  }

  for (const patch of config.patches) {
    const url = rawUrl(patch.repositoryUrl, patch.sourceCommit, patch.path);
    const bytes = await readBounded(
      await fetcher(url, { redirect: 'error', credentials: 'omit' }),
      limits.patch,
      patch.title,
    );
    const fingerprint = patchFingerprint(bytes);
    if (
      bytes.byteLength !== patch.bytes ||
      sha256(bytes) !== patch.sha256 ||
      fingerprint?.format !== 'bps' ||
      fingerprint.sourceSize !== patch.sourceSize ||
      fingerprint.sourceCrc32 !== patch.sourceCrc32
    )
      throw new Error(`Pinned patch identity mismatch: ${patch.title}`);
    const source = {
      id: patch.sourceId,
      name: patch.sourceName,
      url: patch.repositoryUrl,
      revision: patch.sourceCommit,
      license: patch.license,
      notice: patch.notice,
    };
    sourceDefinitions.set(source.id, source);
    usedSources.add(source.id);
    addRecord(
      'patch',
      patch.systemId,
      {
        title: patch.title,
        name: patch.path,
        systemId: patch.systemId,
        size: fingerprint.sourceSize,
        crc32: fingerprint.sourceCrc32,
        source: patch.sourceName,
        sourceIds: [patch.sourceId],
        metadata: { patchType: patch.patchType, license: patch.licenseMetadata },
        resource: {
          url,
          sha256: patch.sha256,
          bytes: patch.bytes,
          format: 'bps',
        },
      },
      `${patch.title}\0${patch.sourceCrc32}\0${patch.sourceSize}`,
    );
  }

  const assets = new Map();
  for (const snapshot of snapshots) {
    const filename = snapshot.definition.archive.filename;
    if (!filename.endsWith('.zip') || assets.has(filename))
      throw new Error('Invalid snapshot asset name');
    assets.set(filename, snapshot.archiveBytes);
  }
  if (snapshots.length)
    assets.set(
      'SOURCE-RECEIPTS.json',
      jsonBytes({
        version: 1,
        snapshots: snapshots.map((snapshot) => snapshot.receipt),
      }),
    );
  const descriptors = [];
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [groupKey, rows] of sortedGroups) {
    const [kind, systemId] = groupKey.split('\0');
    const records = [...rows.values()];
    const chunks = splitRecords(kind, systemId, release, records, limits.shard);
    for (let index = 0; index < chunks.length; index++) {
      const recordsInShard = chunks[index];
      const sourceIds = [...new Set(recordsInShard.flatMap((record) => record.sourceIds))].sort();
      const shardId = `${kind}-${systemId.replaceAll('.', '-')}-${String(index + 1).padStart(3, '0')}`;
      const filename = `${shardId}.json`;
      const shard = { version: 1, release, kind, systemId, records: recordsInShard };
      const bytes = jsonBytes(shard);
      if (bytes.byteLength > limits.shard) throw new Error(`Shard exceeds byte limit: ${filename}`);
      const descriptor = {
        id: shardId,
        kind,
        systemId,
        url: `${releaseRepository}/releases/download/${release}/${filename}`,
        sha256: sha256(bytes),
        bytes: bytes.byteLength,
        records: recordsInShard.length,
        sourceIds,
      };
      validateHostedCatalogShard(shard, descriptor, {
        version: 1,
        release,
        sources: [...usedSources].map((id) =>
          sourceRecord(sourceDefinitions.get(id), libretro.repository, revision),
        ),
        shards: [descriptor],
      });
      assets.set(filename, bytes);
      descriptors.push(descriptor);
    }
  }

  const index = {
    version: 1,
    release,
    sources: [...usedSources]
      .sort()
      .map((id) => sourceRecord(sourceDefinitions.get(id), libretro.repository, revision)),
    shards: descriptors,
  };
  validateHostedCatalogIndex(index);
  const indexBytes = jsonBytes(index);
  if (indexBytes.byteLength > limits.index)
    throw new Error('Hosted catalog index exceeds byte limit');
  assets.set('index.json', indexBytes);

  const sourceDoc = [
    `# Hosted catalog sources (${release})`,
    '',
    `Pinned libretro database commit: [${revision}](${libretro.repository}/tree/${revision}).`,
    '',
    'This release contains catalog metadata and resource pointers. Cheat and patch files are fetched from their original pinned upstream raw URLs; this builder does not copy them into release assets.',
    '',
    '## Sources and notices',
    '',
    ...index.sources.flatMap((source) => [
      `### ${source.name}`,
      '',
      `- Source: ${source.url} (revision ${source.revision})`,
      `- License: ${source.license}`,
      ...(source.notice ? [`- Notice: ${source.notice}`] : []),
      '',
    ]),
    '## Upstream DAT files included',
    '',
    ...libretro.metadataFiles.map(
      (input) => `- \`${input.path}\` → \`${input.systemId}\` (${input.sourceId})`,
    ),
    `- \`${flycast.path}\` → parsed Naomi/Naomi 2/Atomiswave records (${flycast.sourceId})`,
    '',
    ...snapshots.flatMap(({ definition }) => [
      `Snapshot: ${definition.url} → ${definition.systemId}; archive \`${definition.archive.filename}\` (SHA-256 ${definition.archive.sha256}), DAT \`${definition.dat.filename}\` (SHA-256 ${definition.dat.sha256}).`,
      '',
    ]),
    ...(snapshots.length
      ? [
          'Public metadata source archives are included for reproducible offline builds; SOURCE-RECEIPTS.json records their exact sizes, SHA-256 pins and record counts. Only the first track is retained per complete release title; catalog hashes remain unverified until private byte evidence agrees.',
          '',
        ]
      : []),
    'Cheat files are enumerated by the pinned source checkout under the configured `cht/` directories and remain individually linked to commit-addressed raw source files.',
    '',
    `Excluded ${excludedResources.length} cheat files that are empty, have unsupported CHT syntax, or exceed the hosted ${limits.cheats} byte resource limit; see \`EXCLUDED.json\` for paths and sizes.`,
    '',
  ].join('\n');
  assets.set('SOURCES.md', Buffer.from(sourceDoc, 'utf8'));
  assets.set('EXCLUDED.json', jsonBytes({ revision, excludedResources }));
  const checksums = `${[...assets.entries()]
    .filter(([name]) => name !== 'SHA256SUMS.txt')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}`)
    .join('\n')}\n`;
  assets.set('SHA256SUMS.txt', Buffer.from(checksums, 'utf8'));
  const totalBytes = [...assets.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
  if (totalBytes > 512 * 1024 * 1024)
    throw new Error('Hosted catalog release exceeds 512 MiB total');
  return {
    assets,
    index,
    indexBytes,
    summary: {
      release,
      metadataRecords: [...groups.entries()]
        .filter(([key]) => key.startsWith('metadata\0'))
        .reduce((sum, [, rows]) => sum + rows.size, 0),
      cheatRecords: [...groups.entries()]
        .filter(([key]) => key.startsWith('cheats\0'))
        .reduce((sum, [, rows]) => sum + rows.size, 0),
      patchRecords: [...groups.entries()]
        .filter(([key]) => key.startsWith('patch\0'))
        .reduce((sum, [, rows]) => sum + rows.size, 0),
      excludedResources: excludedResources.length,
      shards: descriptors.length,
      bytes: totalBytes,
      indexBytes: indexBytes.byteLength,
      missingInputs: [],
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value)
      throw new Error(
        'Usage: build-hosted-catalog.mjs --source-root PATH --release TAG --output DIR',
      );
    options.set(key, value);
  }
  const sourceRoot = resolve(options.get('--source-root') ?? '');
  const release = options.get('--release');
  const output = resolve(options.get('--output') ?? '');
  if (!release || !options.has('--output') || !options.has('--source-root'))
    throw new Error('Missing required arguments');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const actualRevision = execFileSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  if (actualRevision !== config.libretro.revision)
    throw new Error(
      `Source checkout pin mismatch: expected ${config.libretro.revision}, got ${actualRevision}`,
    );
  const snapshotRoot = options.get('--snapshot-root');
  const built = await buildCatalog({ sourceRoot, snapshotRoot, config, release });
  await mkdir(output, { recursive: true });
  for (const [filename, bytes] of built.assets)
    await writeFile(join(output, filename), bytes, { flag: 'wx' });
  const summary = { ...built.summary, output };
  await writeFile(join(output, 'BUILD-SUMMARY.json'), `${JSON.stringify(summary, null, 2)}\n`, {
    flag: 'wx',
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
