import { randomUUID } from 'node:crypto';
import { link, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { validateSystemIdentifier } from '@ecs/protocol';
import { readRegular } from './player-assets.js';
import { playerCatalog, type TrustedPlayer } from './player-catalog.js';
import {
  catalogJson,
  createPlayerCatalogSnapshot,
  type PlayerCatalogSnapshot,
} from './player-catalog-snapshot.js';
import { validateCatalogPlayerDescriptor } from './player-download.js';
import { MAX_PLAYER_PROFILES } from './player-limits.js';

const MAX_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function invalid(): never {
  throw new Error('Invalid player catalog snapshot');
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) invalid();
  return record;
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
  );
}

function checkEntry(value: unknown): TrustedPlayer {
  const entry = object(value, [
    'id',
    'name',
    'systems',
    'description',
    'available',
    'reason',
    'downloadBytes',
    'url',
    'sha256',
    'upstream',
    'provenance',
  ]);
  if (
    !text(entry.id, 120) ||
    !/^[a-z0-9][a-z0-9._-]*$/.test(entry.id) ||
    !text(entry.name, 80) ||
    !text(entry.description, 4096) ||
    typeof entry.available !== 'boolean' ||
    !(entry.reason === null || text(entry.reason, 4096)) ||
    !(
      entry.downloadBytes === null ||
      (Number.isSafeInteger(entry.downloadBytes) && Number(entry.downloadBytes) > 0)
    ) ||
    !(entry.url === null || text(entry.url, 4096)) ||
    !(entry.sha256 === null || (typeof entry.sha256 === 'string' && SHA256.test(entry.sha256))) ||
    !Array.isArray(entry.systems) ||
    !entry.systems.length ||
    entry.systems.length > 64 ||
    new Set(entry.systems).size !== entry.systems.length
  )
    invalid();
  for (const system of entry.systems) {
    if (typeof system !== 'string') invalid();
    validateSystemIdentifier(system);
  }
  if (entry.upstream !== undefined) {
    const upstream = object(entry.upstream, ['manifest', 'resources']);
    if (
      !Array.isArray(upstream.resources) ||
      upstream.resources.length < 2 ||
      upstream.resources.length > 18
    )
      invalid();
    for (const item of upstream.resources) {
      const resource = object(item, ['url', 'file', 'sha256', 'sizeBytes']);
      if (
        !text(resource.url, 4096) ||
        !text(resource.file, 256) ||
        typeof resource.sha256 !== 'string' ||
        !SHA256.test(resource.sha256) ||
        !Number.isSafeInteger(resource.sizeBytes)
      )
        invalid();
    }
  }
  if (entry.provenance !== undefined) {
    const provenance = object(entry.provenance, [
      'sourceInfo',
      'infoSha256',
      'license',
      'firmware',
    ]);
    if (
      !text(provenance.sourceInfo, 4096) ||
      !text(provenance.license, 1024) ||
      (provenance.infoSha256 !== undefined &&
        (typeof provenance.infoSha256 !== 'string' || !SHA256.test(provenance.infoSha256)))
    )
      invalid();
    const url = new URL(provenance.sourceInfo);
    if (url.protocol !== 'https:' || url.username || url.password) invalid();
    if (provenance.firmware !== undefined) {
      if (!Array.isArray(provenance.firmware) || provenance.firmware.length > 64) invalid();
      for (const item of provenance.firmware) {
        const firmware = object(item, ['path', 'optional']);
        if (!text(firmware.path, 256) || typeof firmware.optional !== 'boolean') invalid();
      }
    }
  }
  const checked = entry as unknown as TrustedPlayer;
  validateCatalogPlayerDescriptor(checked);
  return checked;
}

/** expectedId is an operator trust anchor; the file's embedded ID is not sufficient. */
export function parsePlayerCatalogSnapshot(
  value: unknown,
  expectedId: string,
): PlayerCatalogSnapshot {
  try {
    if (!SHA256.test(expectedId)) invalid();
    const raw = object(value, ['schemaVersion', 'id', 'entries']);
    if (
      raw.schemaVersion !== 1 ||
      raw.id !== expectedId ||
      !Array.isArray(raw.entries) ||
      raw.entries.length > MAX_PLAYER_PROFILES
    )
      invalid();
    const snapshot = createPlayerCatalogSnapshot(raw.entries.map(checkEntry));
    if (snapshot.id !== expectedId) invalid();
    return snapshot;
  } catch {
    return invalid();
  }
}

export async function loadPlayerCatalogSnapshot(
  file: string,
  expectedId: string,
): Promise<PlayerCatalogSnapshot> {
  try {
    if (!isAbsolute(file) || !SHA256.test(expectedId)) invalid();
    const bytes = await readRegular(dirname(file), basename(file), MAX_BYTES);
    return parsePlayerCatalogSnapshot(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      expectedId,
    );
  } catch {
    return invalid();
  }
}

export async function exportPlayerCatalogSnapshot(file: string): Promise<string> {
  const snapshot = createPlayerCatalogSnapshot(playerCatalog);
  parsePlayerCatalogSnapshot(snapshot, snapshot.id);
  const serialized = `${catalogJson(snapshot)}\n`;
  if (Buffer.byteLength(serialized) > MAX_BYTES) invalid();
  const temporary = join(dirname(file), `.player-catalog-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
    await link(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return snapshot.id;
}
