import { crc32 } from 'node:zlib';
import { classifyArtwork } from './artwork-classification.js';
import type { ProviderCapability } from './manifest.js';
import {
  compatibleGameTitles,
  contentStem,
  nameMatchKeys,
  nameMatchScore,
  normalizeSerial,
  normalizeSetAlias,
  releaseFactsConflict,
  serialSubtitleAlias,
} from './matching-names.js';
import type { RomFacts, RomHash } from './rom-facts.js';

export { ARTWORK_ROLES, type ArtworkRole, classifyArtwork } from './artwork-classification.js';
export { normalizeSerial, normalizeSetAlias } from './matching-names.js';

export interface MatchCompanion {
  id: string;
  name: string;
  metadata?: Record<string, string>;
  cheats?: { count: number };
  patch?: { format: 'ips' | 'bps' | 'ups'; sourceCrc32?: string; sourceSize?: number };
}
export interface SelectedMetadataSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly systemId: string;
  readonly metadata: Readonly<Record<string, string>>;
}
export interface MatchingInput {
  name: string;
  systemId: string | null;
  size?: number;
  crc32?: string;
  md5?: string;
  sha1?: string;
  facts?: RomFacts;
  online?: boolean;
  allowExactNames?: boolean;
  selectedMetadata?: SelectedMetadataSnapshot;
  companions: MatchCompanion[];
}
export interface MatchCandidate {
  id: string;
  kind: ProviderCapability;
  title: string;
  confidence: 'checksum' | 'local' | 'name';
  metadata: Record<string, string>;
  fileId?: string;
  url?: string;
}
export interface MatchingProvider {
  id: string;
  name: string;
  capabilities: ProviderCapability[];
  network: boolean;
  search: (input: MatchingInput, signal?: AbortSignal) => Promise<MatchCandidate[]>;
}
export interface MatchingResult {
  candidates: (MatchCandidate & { providerId: string })[];
  problems: { providerId: string; code: 'provider-failed' }[];
}
export interface DatRecord {
  aliases?: string[];
  systemId?: string;
  source?: string;
  title: string;
  name: string;
  size?: number;
  crc32?: string;
  md5?: string;
  sha1?: string;
  serials?: string[];
  setIds?: string[];
  media?: 'rom' | 'disk';
}

/** A provider can preserve healthy source results while reporting a failed auxiliary lookup. */
export class PartialMatchingError extends Error {
  constructor(readonly candidates: MatchCandidate[]) {
    super('Part of this provider lookup failed');
  }
}

/** A manager coordinates providers; it never turns a filename hint into a verified match. */
export async function runMatching(
  input: MatchingInput,
  providers: MatchingProvider[],
  signal?: AbortSignal,
): Promise<MatchingResult> {
  const candidates: MatchingResult['candidates'] = [];
  const problems: MatchingResult['problems'] = [];
  await Promise.all(
    providers.slice(0, 32).map(async (provider) => {
      signal?.throwIfAborted();
      if (provider.network && !input.online) return;
      try {
        const timeout = AbortSignal.timeout(8_000);
        const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const result = await Promise.race([
          provider.search(input, bounded),
          new Promise<never>((_, reject) =>
            bounded.addEventListener('abort', () => reject(new Error('provider timed out')), {
              once: true,
            }),
          ),
        ]);
        const checked = validateCandidates(result, provider.capabilities);
        candidates.push(...checked.map((candidate) => ({ ...candidate, providerId: provider.id })));
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof PartialMatchingError) {
          try {
            candidates.push(
              ...validateCandidates(error.candidates, provider.capabilities).map((candidate) => ({
                ...candidate,
                providerId: provider.id,
              })),
            );
          } catch {
            /* Malformed partial results remain a provider failure. */
          }
        }
        problems.push({ providerId: provider.id, code: 'provider-failed' });
      }
    }),
  );
  problems.sort((a, b) => a.providerId.localeCompare(b.providerId));
  const rank = { checksum: 0, local: 1, name: 2 };
  candidates.sort(
    (a, b) =>
      rank[a.confidence] - rank[b.confidence] ||
      a.providerId.localeCompare(b.providerId) ||
      a.id.localeCompare(b.id),
  );
  const reconciled = reconcileCandidates(input, candidates).slice(0, 100);
  return {
    candidates: reconciled.map((candidate) =>
      exactNameEvidence(input, candidate) &&
      !automaticEvidence({ ...input, allowExactNames: false }, candidate) &&
      (candidate.metadata.matchEvidence !== undefined ||
        Object.keys(candidate.metadata).length < 24)
        ? {
            ...candidate,
            confidence: 'name',
            metadata: { ...candidate.metadata, matchEvidence: 'exact-name' },
          }
        : candidate,
    ),
    problems,
  };
}

export function validateCandidates(
  value: unknown,
  capabilities: readonly ProviderCapability[],
): MatchCandidate[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid provider response');
  const ids = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid candidate');
    const c = raw as Record<string, unknown>;
    if (
      !text(c.id, 200) ||
      ids.has(c.id) ||
      !text(c.title, 512) ||
      !capabilities.includes(c.kind as ProviderCapability) ||
      !['checksum', 'local', 'name'].includes(String(c.confidence))
    )
      throw new Error('Invalid candidate');
    ids.add(c.id);
    if (!c.metadata || typeof c.metadata !== 'object' || Array.isArray(c.metadata))
      throw new Error('Invalid metadata');
    const metadata: Record<string, string> = {};
    const entries = Object.entries(c.metadata);
    if (entries.length > 24) throw new Error('Too much metadata');
    for (const [key, value] of entries) {
      if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(key) || !text(value, 4096))
        throw new Error('Invalid metadata');
      Object.defineProperty(metadata, key, { value, enumerable: true });
    }
    const candidate: MatchCandidate = {
      id: c.id,
      kind: c.kind as ProviderCapability,
      title: c.title,
      confidence: c.confidence as MatchCandidate['confidence'],
      metadata,
    };
    if (c.fileId !== undefined) {
      if (!text(c.fileId, 200)) throw new Error('Invalid file id');
      candidate.fileId = c.fileId;
    }
    if (c.url !== undefined) {
      if (!text(c.url, 2048)) throw new Error('Invalid link');
      const url = new URL(c.url);
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new Error('Invalid link');
      candidate.url = url.href;
    }
    return candidate;
  });
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)),
    )
  );
}

function stem(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .normalize('NFC')
    .toLowerCase();
}
export const localMatchingProvider: MatchingProvider = {
  id: 'org.ecs.local',
  name: 'Local files',
  capabilities: ['metadata', 'artwork', 'patch'],
  network: false,
  async search(input) {
    const matches: MatchCandidate[] = [];
    const target = stem(input.name);
    for (const companion of input.companions.slice(0, 100)) {
      const artwork = classifyArtwork(companion.name);
      const image = /\.(png|jpe?g|webp)$/i.test(companion.name);
      const manual = /\.pdf$/i.test(companion.name) && artwork.role === 'manual';
      const sameName =
        (image || manual
          ? artwork.baseTitle.normalize('NFC').toLowerCase()
          : stem(companion.name).replace(
              /(?:[ ._-](?:translation|rom[ ._-]?hack|hack|patch))$/,
              '',
            )) === target;
      const patch = companion.patch;
      const eligible = inputHashes(input).filter(
        (hash) => hash.algorithm === 'crc32' && hash.verified,
      );
      const baseHash = patch?.sourceCrc32
        ? eligible.find(
            (hash) =>
              hash.value === patch.sourceCrc32?.toLowerCase() && hash.size === patch.sourceSize,
          )
        : undefined;
      const sameBase = !!baseHash;
      if (!sameName && !sameBase) continue;
      const base = {
        id: companion.id,
        title: input.name.replace(/\.[^.]+$/, ''),
        fileId: companion.id,
      };
      if (companion.metadata) {
        matches.push({
          ...base,
          title: companion.metadata.title ?? base.title,
          kind: 'metadata',
          confidence: 'local',
          metadata: companion.metadata,
        });
      } else if (image || manual) {
        matches.push({
          ...base,
          kind: 'artwork',
          confidence: 'local',
          metadata: { artworkRole: artwork.role, imageKind: manual ? 'pdf' : 'image' },
        });
      } else if (patch) {
        // Checksummed patches for another known base are rejected, including normalized representations.
        if (patch.sourceCrc32 && eligible.length && !sameBase) continue;
        const patchType = /(?:^|[ ._([/-])translation(?:[ ._)\]/-]|$)/i.test(companion.name)
          ? 'translation'
          : /(?:^|[ ._([/-])(?:rom[ ._-]?)?hack(?:[ ._)\]/-]|$)/i.test(companion.name)
            ? 'rom-hack'
            : 'patch';
        matches.push({
          ...base,
          kind: 'patch',
          confidence: sameBase ? 'checksum' : 'name',
          metadata: {
            format: patch.format,
            patchType,
            ...(baseHash
              ? {
                  crc32: baseHash.value,
                  hashSize: String(baseHash.size),
                  hashRepresentation: baseHash.representation,
                  matchEvidence: 'verified-hash',
                }
              : {}),
            verification: sameBase ? 'Base checksum and size match' : 'Base ROM not verified',
          },
        });
      }
    }
    return matches;
  },
};

/** Small clrmamepro tokenizer: quoted titles may themselves contain parentheses. */
export function parseLibretroDat(source: string): DatRecord[] {
  if (source.length > 16 * 1024 * 1024) throw new Error('DAT too large');
  const tokens = source.match(/"(?:\\.|[^"\\])*"|[()]|[^\s()"]+/g) ?? [];
  let at = 0;
  const scalar = (token: string): string =>
    token.startsWith('"') ? token.slice(1, -1).replace(/\\(["\\])/g, '$1') : token;
  type Block = { fields: Record<string, string>; children: { key: string; block: Block }[] };
  function block(depth: number): Block {
    if (depth > 8) throw new Error('DAT nesting too deep');
    const value: Block = { fields: {}, children: [] };
    while (at < tokens.length) {
      const key = tokens[at++];
      if (key === ')') return value;
      const next = tokens[at++];
      if (!key || next === undefined || next === ')') throw new Error('Malformed DAT');
      if (next === '(') value.children.push({ key, block: block(depth + 1) });
      else value.fields[key] = scalar(next);
    }
    if (depth > 0) throw new Error('Unclosed DAT block');
    return value;
  }
  const parsed = block(0);
  const records: DatRecord[] = [];
  for (const game of parsed.children.filter((child) => child.key === 'game')) {
    for (const rom of game.block.children.filter((child) => ['rom', 'disk'].includes(child.key))) {
      const fields = rom.block.fields;
      const title = game.block.fields.name;
      const size = fields.size === undefined ? undefined : Number(fields.size);
      if (
        !title ||
        title.length > 512 ||
        !fields.name ||
        fields.name.length > 512 ||
        (size !== undefined && (!Number.isSafeInteger(size) || size < 0))
      )
        continue;
      const serials = [
        ...new Set(
          [game.block.fields.serial, fields.serial]
            .flatMap((value) => value?.split(/\s*[,;]\s*/) ?? [])
            .filter((value) => value.length > 0 && value.length <= 160),
        ),
      ].slice(0, 32);
      records.push({
        title,
        ...(game.block.fields.id && game.block.fields.id.length <= 160
          ? { aliases: [game.block.fields.id], setIds: [game.block.fields.id] }
          : {}),
        name: fields.name,
        ...(size === undefined ? {} : { size }),
        ...(rom.key === 'disk' ? { media: 'disk' as const } : {}),
        ...(serials.length ? { serials } : {}),
        ...(/^[0-9a-f]{8}$/i.test(fields.crc ?? '') ? { crc32: fields.crc?.toLowerCase() } : {}),
        ...(/^[0-9a-f]{32}$/i.test(fields.md5 ?? '') ? { md5: fields.md5?.toLowerCase() } : {}),
        ...(/^[0-9a-f]{40}$/i.test(fields.sha1 ?? '') ? { sha1: fields.sha1?.toLowerCase() } : {}),
      });
    }
  }
  return records;
}
export function matchLibretro(input: MatchingInput, records: DatRecord[]): MatchCandidate[] {
  return matchEntries(input, records.entries());
}
/** Compile once for an immutable parsed catalog, retaining its original candidate IDs. */
export function createLibretroMatcher(
  records: readonly DatRecord[],
): (input: MatchingInput) => MatchCandidate[] {
  const snapshot = records.slice(),
    buckets = new Map<string, Set<number>>();
  const add = (key: string, index: number) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = new Set();
      buckets.set(key, bucket);
    }
    bucket.add(index);
  };
  snapshot.forEach((record, index) => {
    for (const name of [record.name, record.title])
      for (const key of nameMatchKeys(name)) add(`name:${key}`, index);
    if (record.systemId)
      for (const alias of [record.name, ...(record.aliases ?? [])])
        add(`alias:${alias.toLowerCase()}`, index);
    for (const algorithm of HASH_ALGORITHMS) {
      const value = record[algorithm];
      if (value)
        add(`${algorithm}:${record.media === 'disk' ? 'disk' : record.size}:${value}`, index);
    }
    for (const serial of record.serials ?? []) add(`serial:${normalizeSerial(serial)}`, index);
    for (const id of record.setIds ?? []) add(`set:${normalizeSetAlias(id)}`, index);
  });
  return (input) => {
    const indices = new Set<number>();
    const take = (key: string) => {
      for (const index of buckets.get(key) ?? []) indices.add(index);
    };
    for (const name of [input.name, ...(input.facts?.names ?? [])]) {
      for (const key of nameMatchKeys(name)) take(`name:${key}`);
      const stem = contentStem(name).toLowerCase();
      take(`alias:${stem}`);
      take(`alias:${stem.replace(/-(?:[2-9][0-9]*|chd)$/, '')}`);
      take(`set:${normalizeSetAlias(name)}`);
    }
    for (const hash of inputHashes(input)) {
      take(`${hash.algorithm}:${hash.size}:${hash.value}`);
      if (hash.algorithm === 'sha1' && hash.representation === 'chd-combined-sha1')
        take(`sha1:disk:${hash.value}`);
    }
    for (const id of input.facts?.identifiers ?? [])
      if (!id.systemId || !input.systemId || id.systemId === input.systemId)
        take(
          `${id.type}:${id.type === 'serial' ? normalizeSerial(id.value) : normalizeSetAlias(id.value)}`,
        );
    return matchEntries(
      input,
      [...indices]
        .sort((a, b) => a - b)
        .flatMap((index): Array<[number, DatRecord]> => {
          const record = snapshot[index];
          return record ? [[index, record]] : [];
        }),
    );
  };
}
function matchEntries(
  input: MatchingInput,
  records: Iterable<[number, DatRecord]>,
): MatchCandidate[] {
  const found: MatchCandidate[] = [];
  for (const [index, record] of records) {
    if (input.systemId && record.systemId && input.systemId !== record.systemId) continue;
    const metadata: Record<string, string> = {
      title: record.title,
      ...((record.systemId ?? input.systemId)
        ? { systemId: record.systemId ?? input.systemId ?? '' }
        : {}),
      romName: record.name,
      source: record.source ?? 'Libretro database',
      ...(record.size === undefined ? {} : { hashSize: String(record.size) }),
      ...(record.media ? { hashMedia: record.media } : {}),
      ...(record.crc32 ? { crc32: record.crc32 } : {}),
      ...(record.md5 ? { md5: record.md5 } : {}),
      ...(record.sha1 ? { sha1: record.sha1 } : {}),
      ...(record.serials?.length ? { serials: JSON.stringify(record.serials) } : {}),
      ...(record.setIds?.length ? { setIds: JSON.stringify(record.setIds) } : {}),
    };
    const proof = assessEvidence(input, metadata);
    const arcadeAlias = (value: string) =>
      normalizeSetAlias(value).replace(/-(?:[2-9][0-9]*|chd)$/, '');
    const aliasMatch =
      !!record.systemId &&
      [record.name, ...(record.aliases ?? []), ...(record.setIds ?? [])].some(
        (alias) =>
          normalizeSetAlias(input.name) === normalizeSetAlias(alias) ||
          arcadeAlias(input.name) === normalizeSetAlias(alias),
      );
    if (
      !proof.matched &&
      !aliasMatch &&
      ![input.name, ...(input.facts?.names ?? [])].some(
        (name) => nameMatchScore(name, record.name) || nameMatchScore(name, record.title),
      )
    )
      continue;
    metadata.matchEvidence = proof.serialConflict
      ? 'serial-conflict'
      : proof.conflict
        ? 'hash-conflict'
        : proof.verifiedHash
          ? 'verified-hash'
          : proof.declaredHash
            ? 'declared-hash'
            : proof.verifiedSerial
              ? 'verified-serial'
              : proof.serial
                ? 'declared-serial'
                : proof.set || aliasMatch
                  ? 'set-alias'
                  : 'name';
    if (proof.representation) metadata.hashRepresentation = proof.representation;
    const candidate: MatchCandidate = {
      id: `dat-${index}`,
      kind: 'metadata',
      title: record.title,
      confidence: proof.verifiedHash && !proof.conflict ? 'checksum' : 'name',
      metadata,
    };
    if (!proof.verifiedHash && !proof.verifiedSerial && exactNameEvidence(input, candidate))
      metadata.matchEvidence = 'exact-name';
    if (found.length < 100) found.push(candidate);
    else if (candidate.confidence === 'checksum') {
      const replace = found.findLastIndex((row) => row.confidence !== 'checksum');
      if (replace >= 0) found[replace] = candidate;
    }
  }
  return reconcileCandidates(input, found)
    .sort((a, b) => Number(b.confidence === 'checksum') - Number(a.confidence === 'checksum'))
    .slice(0, 30);
}

const HASH_ALGORITHMS = ['md5', 'sha1', 'crc32'] as const;
function inputHashes(input: MatchingInput): RomHash[] {
  const hashes = [...(input.facts?.hashes ?? [])];
  if (input.size !== undefined)
    for (const algorithm of HASH_ALGORITHMS) {
      const value = input[algorithm];
      if (value)
        hashes.push({
          algorithm,
          value: value.toLowerCase(),
          size: input.size,
          representation: 'raw',
          verified: true,
        });
    }
  return hashes;
}
function identifiers(value: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) && parsed.length <= 32
      ? parsed.filter((v): v is string => typeof v === 'string' && v.length <= 160)
      : [];
  } catch {
    return [];
  }
}
function assessEvidence(input: MatchingInput, metadata: Record<string, string>) {
  const groups = new Map<string, RomHash[]>();
  for (const hash of inputHashes(input)) {
    if (metadata.hashRepresentation && metadata.hashRepresentation !== hash.representation)
      continue;
    if (metadata.hashMedia !== 'disk' && hash.representation.startsWith('chd-')) continue;
    if (
      metadata.hashMedia === 'disk'
        ? hash.algorithm !== 'sha1' || hash.representation !== 'chd-combined-sha1'
        : metadata.hashSize === undefined || Number(metadata.hashSize) !== hash.size
    )
      continue;
    const key = `${hash.representation}\0${hash.size}`,
      group = groups.get(key) ?? [];
    group.push(hash);
    groups.set(key, group);
  }
  let verifiedHash = false,
    declaredHash = false,
    conflict = false,
    hashHit = false,
    representation: string | undefined;
  for (const group of groups.values()) {
    const common = group.filter((hash) => !!metadata[hash.algorithm]);
    if (!common.length) continue;
    hashHit ||= common.some(
      (hash) => hash.value.toLowerCase() === metadata[hash.algorithm]?.toLowerCase(),
    );
    const mismatch = common.some(
      (hash) => hash.value.toLowerCase() !== metadata[hash.algorithm]?.toLowerCase(),
    );
    if (mismatch) {
      conflict = true;
      continue;
    }
    declaredHash = true;
    const verified = common.some((hash) => hash.verified);
    if (!representation || (verified && !verifiedHash)) representation = group[0]?.representation;
    verifiedHash ||= verified;
  }
  // Distinct byte representations may legitimately disagree; only verified bytes can resolve that.
  if (verifiedHash) conflict = false;
  const expectedSerials = identifiers(metadata.serials).map(normalizeSerial);
  const expectedSets = identifiers(metadata.setIds).map(normalizeSetAlias);
  let serial = false,
    verifiedSerial = false,
    set = false;
  for (const id of input.facts?.identifiers ?? []) {
    if (metadata.systemId && id.systemId && metadata.systemId !== id.systemId) continue;
    if (input.systemId && id.systemId && input.systemId !== id.systemId) continue;
    if (id.type === 'serial' && expectedSerials.includes(normalizeSerial(id.value))) {
      serial = true;
      verifiedSerial ||= id.verified;
    }
    if (id.type === 'set' && expectedSets.includes(normalizeSetAlias(id.value))) set = true;
  }
  // A multi-track image may expose several valid IDs. Keep every hint, but never
  // turn the first matching track (or board) into a unique game identity.
  const verifiedIds = (input.facts?.identifiers ?? []).filter(
    (id) => id.type === 'serial' && id.verified,
  );
  const serialConflict =
    new Set(verifiedIds.map((id) => normalizeSerial(id.value))).size > 1 ||
    new Set(verifiedIds.flatMap((id) => (id.systemId ? [id.systemId] : []))).size > 1;
  return {
    verifiedHash,
    declaredHash,
    conflict: conflict || serialConflict,
    serialConflict,
    serial,
    verifiedSerial,
    set,
    representation,
    matched: hashHit || serial || set,
  };
}
/** Opt-in filename policy: full release text is retained; no title/region/edition guessing. */
function exactNameEvidence(input: MatchingInput, candidate: MatchCandidate): boolean {
  if (!input.allowExactNames || !['metadata', 'artwork'].includes(candidate.kind)) return false;
  if (candidate.kind === 'artwork' && candidate.metadata.artworkReviewRequired === 'true')
    return false;
  // Catalog identity is explicit; a plain local sidecar association is not this policy.
  if (!input.systemId || candidate.metadata.systemId !== input.systemId) return false;
  if (
    candidate.metadata.identityConflict === 'true' ||
    ['identity-conflict', 'hash-conflict', 'serial-conflict'].includes(
      candidate.metadata.matchEvidence ?? '',
    )
  )
    return false;
  if (
    input.systemId &&
    candidate.metadata.systemId &&
    input.systemId !== candidate.metadata.systemId
  )
    return false;
  if (
    candidate.kind === 'artwork' &&
    (candidate.metadata.artworkRole !== 'front' || !input.systemId)
  )
    return false;
  const exact = (value: string) =>
    contentStem(value)
      .normalize('NFC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}]/gu, '');
  const name = exact(input.name);
  if (
    !name ||
    ![
      candidate.title,
      ...(candidate.kind === 'metadata' && candidate.metadata.romName
        ? [candidate.metadata.romName]
        : []),
    ].some((value) => exact(value) === name)
  )
    return false;
  if (releaseFactsConflict(input.name, candidate.metadata.title ?? candidate.title)) return false;
  const evidence = assessEvidence(input, candidate.metadata);
  if (evidence.conflict) return false;
  const serials = identifiers(candidate.metadata.serials).map(normalizeSerial);
  if (
    (input.facts?.identifiers ?? []).some(
      (id) =>
        id.verified &&
        ((id.systemId &&
          ((input.systemId && input.systemId !== id.systemId) ||
            (candidate.metadata.systemId && candidate.metadata.systemId !== id.systemId))) ||
          (id.type === 'serial' && !serials.includes(normalizeSerial(id.value)))),
    )
  )
    return false;
  const hashes = inputHashes(input).filter(
    (hash) => hash.verified && !hash.representation.startsWith('chd-'),
  );
  // A known different byte length cannot be erased by a matching label.
  if (
    candidate.metadata.hashMedia !== 'disk' &&
    candidate.metadata.hashSize !== undefined &&
    HASH_ALGORITHMS.some((algorithm) => candidate.metadata[algorithm]) &&
    hashes.length &&
    !hashes.some((hash) => hash.size === Number(candidate.metadata.hashSize))
  )
    return false;
  return true;
}
function discIdentityConflict(input: MatchingInput): boolean {
  return (
    input.facts?.warnings.some((warning) =>
      ['disc-system-conflict', 'disc-identifiers-conflict'].includes(warning),
    ) ?? false
  );
}
/** A saved choice is authority for its artwork association, never new ROM metadata. */
export function selectedArtworkAnchor(
  input: MatchingInput,
): { identity: MatchCandidate; titles: string[] } | null {
  if (discIdentityConflict(input)) return null;
  const saved = input.selectedMetadata;
  if (
    !saved ||
    !text(saved.id, 200) ||
    !Number.isSafeInteger(saved.revision) ||
    saved.revision < 0 ||
    !text(saved.title, 512) ||
    !input.systemId ||
    saved.systemId !== input.systemId ||
    !saved.metadata ||
    typeof saved.metadata !== 'object' ||
    Array.isArray(saved.metadata)
  )
    return null;
  const entries = Object.entries(saved.metadata);
  if (
    entries.length > 24 ||
    entries.some(([key, value]) => !/^[a-z][a-zA-Z0-9]{0,31}$/.test(key) || !text(value, 4096))
  )
    return null;
  if (saved.metadata.systemId && saved.metadata.systemId !== saved.systemId) return null;
  const metadata: Record<string, string> = {
    ...saved.metadata,
    systemId: saved.systemId,
    title: saved.title,
  };
  if (assessEvidence(input, metadata).conflict) return null;
  const serials = identifiers(metadata.serials).map(normalizeSerial);
  if (
    (input.facts?.identifiers ?? []).some(
      (id) =>
        id.verified &&
        ((id.systemId && id.systemId !== saved.systemId) ||
          (id.type === 'serial' &&
            serials.length > 0 &&
            !serials.includes(normalizeSerial(id.value)))),
    )
  )
    return null;
  const identity: MatchCandidate = {
    id: saved.id,
    kind: 'metadata',
    title: saved.title,
    confidence: 'name',
    metadata,
  };
  const originals = provenanceRows(identity);
  if (!originals || originals.some((row) => assessEvidence(input, row.metadata).conflict))
    return null;
  const titles = [
    ...new Set([
      saved.title,
      ...originals
        .filter((row) => compatibleCatalogIdentity(input, identity, row))
        .map((row) => row.title),
    ]),
  ];
  const romNames = [
    metadata.romName,
    ...originals
      .filter((row) => compatibleCatalogIdentity(input, identity, row))
      .map((row) => row.metadata.romName),
  ]
    .filter(
      (name): name is string => !!name && compatibleGameTitles(saved.title, contentStem(name)),
    )
    .map(contentStem);
  const suffixes = [...identifiers(metadata.serials), ...identifiers(metadata.setIds)];
  return {
    identity,
    titles: [
      ...new Set([
        ...titles,
        ...romNames,
        ...titles.flatMap((title) => suffixes.map((id) => `${title} (${id})`)),
      ]),
    ],
  };
}
function savedSelectionEvidence(input: MatchingInput, candidate: MatchCandidate): boolean {
  if (
    candidate.kind !== 'artwork' ||
    candidate.metadata.artworkRole !== 'front' ||
    candidate.metadata.matchEvidence !== 'saved-selection'
  )
    return false;
  const anchor = selectedArtworkAnchor(input),
    saved = input.selectedMetadata;
  if (
    !anchor ||
    !saved ||
    candidate.metadata.savedMetadataId !== saved.id ||
    candidate.metadata.savedMetadataRevision !== String(saved.revision) ||
    candidate.metadata.systemId !== saved.systemId
  )
    return false;
  const canonical = (value: string) =>
    value
      .normalize('NFC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}]/gu, '');
  return (
    canonical(candidate.metadata.matchedGame ?? '') === canonical(saved.title) &&
    anchor.titles.some((title) => canonical(title) === canonical(candidate.title))
  );
}
/** Recheck private byte/serial facts. Provider confidence or hashVerified markers are never authority. */
export function automaticEvidence(input: MatchingInput, candidate: MatchCandidate): boolean {
  if (discIdentityConflict(input)) return false;
  if (candidate.kind === 'artwork' && candidate.metadata.artworkReviewRequired === 'true')
    return false;
  if (
    input.systemId &&
    candidate.metadata.systemId &&
    input.systemId !== candidate.metadata.systemId
  )
    return false;
  if (
    candidate.metadata.identityConflict === 'true' ||
    candidate.metadata.matchEvidence === 'identity-conflict'
  )
    return false;
  if (candidate.kind === 'artwork' && candidate.metadata.artworkRole !== 'front') return false;
  if (!['metadata', 'artwork', 'patch'].includes(candidate.kind)) return false;
  if (
    candidate.kind === 'patch' &&
    (!candidate.metadata.crc32 || candidate.metadata.hashSize === undefined)
  )
    return false;
  if (
    candidate.metadata.matchEvidence === 'saved-selection' &&
    !savedSelectionEvidence(input, candidate)
  )
    return false;
  const evidence = assessEvidence(input, candidate.metadata);
  const layers = provenanceRows(candidate);
  if (!layers || layers.some((row) => assessEvidence(input, row.metadata).conflict)) return false;
  return (
    !evidence.conflict &&
    (evidence.verifiedHash ||
      (candidate.kind !== 'patch' && evidence.verifiedSerial) ||
      exactNameEvidence(input, candidate) ||
      savedSelectionEvidence(input, candidate))
  );
}
function compatibleMetadata(left: Record<string, string>, right: Record<string, string>): boolean {
  if (left.systemId && right.systemId && left.systemId !== right.systemId) return false;
  if (
    left.hashRepresentation &&
    right.hashRepresentation &&
    left.hashRepresentation !== right.hashRepresentation
  )
    return false;
  // Distinct file sizes describe separate tracks/variants; every original hash stays in provenance.
  if (left.hashSize === right.hashSize)
    for (const algorithm of HASH_ALGORITHMS)
      if (left[algorithm] && right[algorithm] && left[algorithm] !== right[algorithm]) return false;
  for (const field of ['serials', 'setIds'] as const) {
    const a = identifiers(left[field]).map(
        field === 'serials' ? normalizeSerial : normalizeSetAlias,
      ),
      b = identifiers(right[field]).map(field === 'serials' ? normalizeSerial : normalizeSetAlias);
    if (a.length && b.length && !a.some((value) => b.includes(value))) return false;
  }
  return true;
}
/** Validate inherited reconciliation records before using them to merge another source. */
function provenanceRows(
  candidate: MatchCandidate,
): Array<{ title: string; metadata: Record<string, string>; [key: string]: unknown }> | null {
  if (!candidate.metadata.matchProvenance) return [{ ...candidate }];
  try {
    const rows: unknown = JSON.parse(candidate.metadata.matchProvenance);
    if (!Array.isArray(rows) || !rows.length || rows.length > 100) return null;
    if (
      rows.some(
        (row) =>
          !row ||
          typeof row !== 'object' ||
          typeof row.title !== 'string' ||
          !row.metadata ||
          typeof row.metadata !== 'object' ||
          Array.isArray(row.metadata) ||
          Object.values(row.metadata).some((value) => typeof value !== 'string'),
      )
    )
      return null;
    return rows.map((row) => ({
      ...row,
      ...('providerId' in candidate && !row.providerId ? { providerId: candidate.providerId } : {}),
    }));
  } catch {
    return null;
  }
}
/** Detect an identity contradiction within one game's release family, not unrelated filename hints. */
export function hasIdentityConflict(
  input: MatchingInput,
  candidates: readonly MatchCandidate[],
  candidate?: MatchCandidate,
): boolean {
  return candidates.some((conflict) => {
    if (conflict.kind !== 'metadata' || !assessEvidence(input, conflict.metadata).conflict)
      return false;
    if (!candidate) return true;
    if (!['metadata', 'artwork'].includes(candidate.kind)) return false;
    const system = candidate.metadata.systemId ?? input.systemId;
    if (system !== (conflict.metadata.systemId ?? input.systemId)) return false;
    return nameMatchScore(candidate.metadata.matchedGame ?? candidate.title, conflict.title) > 0;
  });
}
/** Exact verified serials may corroborate a catalog's primary-title/subtitle alias. */
export function compatibleCatalogIdentity(
  input: MatchingInput,
  left: Pick<MatchCandidate, 'title' | 'metadata'>,
  right: Pick<MatchCandidate, 'title' | 'metadata'>,
): boolean {
  if (compatibleGameTitles(left.title, right.title)) return true;
  if (
    !serialSubtitleAlias(left.title, right.title) ||
    !compatibleMetadata(left.metadata, right.metadata)
  )
    return false;
  if (
    assessEvidence(input, left.metadata).conflict ||
    assessEvidence(input, right.metadata).conflict
  )
    return false;
  const a = identifiers(left.metadata.serials).map(normalizeSerial),
    b = identifiers(right.metadata.serials).map(normalizeSerial);
  return (input.facts?.identifiers ?? []).some(
    (id) =>
      id.type === 'serial' &&
      id.verified &&
      (!id.systemId ||
        ((!left.metadata.systemId || left.metadata.systemId === id.systemId) &&
          (!right.metadata.systemId || right.metadata.systemId === id.systemId))) &&
      a.includes(normalizeSerial(id.value)) &&
      b.includes(normalizeSerial(id.value)),
  );
}
/** Merge compatible same-game suggestions; never truncate provenance to make conflicting evidence disappear. */
export function reconcileCandidates<T extends MatchCandidate>(
  input: MatchingInput,
  candidates: readonly T[],
): T[] {
  const result: T[] = [];
  for (const candidate of candidates) {
    let merged = false;
    for (let index = 0; index < result.length; index++) {
      const existing = result[index];
      if (
        !existing ||
        existing.kind !== candidate.kind ||
        !compatibleCatalogIdentity(input, existing, candidate) ||
        !compatibleMetadata(existing.metadata, candidate.metadata)
      )
        continue;
      const leftRows = provenanceRows(existing),
        rightRows = provenanceRows(candidate);
      if (
        !leftRows ||
        !rightRows ||
        leftRows.some((left) =>
          rightRows.some(
            (right) =>
              !compatibleCatalogIdentity(input, left, right) ||
              !compatibleMetadata(left.metadata, right.metadata),
          ),
        )
      )
        continue;
      if (
        candidate.kind === 'artwork' &&
        (existing.metadata.artworkRole !== candidate.metadata.artworkRole ||
          existing.url !== candidate.url ||
          existing.fileId !== candidate.fileId)
      )
        continue;
      if (candidate.kind !== 'metadata' && candidate.kind !== 'artwork') continue;
      const combined = JSON.stringify([...leftRows, ...rightRows]);
      const preferred =
        automaticEvidence(input, candidate) && !automaticEvidence(input, existing)
          ? candidate
          : existing;
      const metadata: Record<string, string> = {
        ...existing.metadata,
        ...candidate.metadata,
        ...preferred.metadata,
        matchProvenance: combined,
      };
      if (existing.metadata.hashSize !== candidate.metadata.hashSize)
        for (const key of [...HASH_ALGORITHMS, 'hashSize', 'hashMedia', 'hashRepresentation']) {
          delete metadata[key];
          if (preferred.metadata[key]) metadata[key] = preferred.metadata[key];
        }
      if (combined.length > 4096 || Object.keys(metadata).length > 24) continue;
      // Non-identity metadata must not be silently overwritten either.
      const identityKeys = new Set([
        'title',
        'romName',
        'source',
        'matchEvidence',
        'hashRepresentation',
        'hashSize',
        'hashMedia',
        'md5',
        'sha1',
        'crc32',
        'serials',
        'setIds',
        'matchProvenance',
        'catalogRelease',
        'catalogShard',
        'catalogRecord',
        'catalogSourceIds',
      ]);
      if (
        Object.keys(existing.metadata).some(
          (key) =>
            !identityKeys.has(key) &&
            candidate.metadata[key] &&
            existing.metadata[key] !== candidate.metadata[key],
        )
      )
        continue;
      const evidence = assessEvidence(input, metadata);
      if (evidence.conflict) {
        metadata.matchEvidence = evidence.serialConflict ? 'serial-conflict' : 'hash-conflict';
        result[index] = { ...preferred, confidence: 'name', metadata };
      } else result[index] = { ...preferred, metadata };
      merged = true;
      break;
    }
    if (!merged) result.push(candidate);
  }
  const conflicts = result.filter(
    (candidate) =>
      candidate.kind === 'metadata' && assessEvidence(input, candidate.metadata).conflict,
  );
  if (!conflicts.length) return result;
  return result.map((candidate) => {
    if (!hasIdentityConflict(input, conflicts, candidate)) return candidate;
    if (
      Object.keys(candidate.metadata).length < 24 ||
      candidate.metadata.identityConflict !== undefined
    )
      return { ...candidate, metadata: { ...candidate.metadata, identityConflict: 'true' } };
    // Preserve a full metadata object; callers can also use hasIdentityConflict for this rare case.
    if (candidate.metadata.matchEvidence !== undefined)
      return {
        ...candidate,
        metadata: { ...candidate.metadata, matchEvidence: 'identity-conflict' },
      };
    return candidate;
  });
}

/** Reads patch identity only; never applies it or changes the source ROM. */
export function patchFingerprint(bytes: Uint8Array): MatchCompanion['patch'] | null {
  const buffer = Buffer.from(bytes);
  if (
    buffer.subarray(0, 5).toString() === 'PATCH' &&
    (buffer.subarray(-3).toString() === 'EOF' || buffer.subarray(-6, -3).toString() === 'EOF')
  )
    return { format: 'ips' };
  const signature = buffer.subarray(0, 4).toString();
  if (
    !['BPS1', 'UPS1'].includes(signature) ||
    buffer.length < 18 ||
    buffer.length > 2 * 1024 * 1024 ||
    crc32(buffer.subarray(0, -4)) !== buffer.readUInt32LE(buffer.length - 4)
  )
    return null;
  let at = 4;
  function integer(): number {
    let value = 0;
    let shift = 1;
    for (let count = 0; count < 8; count++) {
      if (at >= buffer.length - 12) throw new Error('Invalid patch integer');
      const byte = buffer[at++];
      if (byte === undefined) throw new Error('Invalid patch byte');
      value += (byte & 127) * shift;
      if (!Number.isSafeInteger(value)) throw new Error('Invalid patch integer');
      if (byte & 128) return value;
      shift *= 128;
      value += shift;
    }
    throw new Error('Invalid patch integer');
  }
  try {
    const sourceSize = integer();
    integer();
    return {
      format: signature === 'BPS1' ? 'bps' : 'ups',
      sourceSize,
      sourceCrc32: buffer
        .readUInt32LE(buffer.length - 12)
        .toString(16)
        .padStart(8, '0'),
    };
  } catch {
    return null;
  }
}
