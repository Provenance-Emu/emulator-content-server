import type { Readable } from 'node:stream';
import type { AssetKind, GuestCapability, ItemPermission, LibraryRole } from '@ecs/protocol';

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, string>;

  constructor(code: string, status: number, message: string, details?: Record<string, string>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export interface LibraryRecord {
  id: string;
  name: string;
  ownerId: string;
  revision: number;
  createdAt: string;
}

export interface ContentRootRecord {
  id: string;
  path: string;
  label: string;
  libraryId: string | null;
  createdAt: string;
}

export type SourceAvailability = 'local' | 'evicted' | 'offline';
export type SourceArtworkRole =
  | 'front'
  | 'back'
  | 'disc'
  | 'manual'
  | 'title'
  | 'screenshot'
  | 'other';

export interface SourceFileRecord {
  id: string;
  rootId: string;
  libraryId: string | null;
  relativePath: string;
  displayName: string;
  size: number;
  blocks: number;
  kind: AssetKind;
  systemId: string | null;
  availability: SourceAvailability;
  title?: string;
  artworkAvailable?: boolean;
  groupAnchor?: string | null;
  groupMembers?: string[];
  groupError?: string | null;
}

export interface SourceMatchRecord {
  id: string;
  providerId: string;
  kind: 'rom' | 'metadata' | 'artwork' | 'patch' | 'cheats';
  artworkRole?: SourceArtworkRole;
  title: string;
  confidence: 'checksum' | 'local' | 'name';
  metadata: Record<string, string>;
  originKind: AssetKind | null;
  originFileId?: string;
  originUrl?: string;
  contentAvailable: boolean;
  contentType: string | null;
  fileName: string | null;
  updatedAt: string;
}
export interface SourceMatchState {
  sourceId: string;
  revision: number;
  matches: SourceMatchRecord[];
}

export interface ItemRecord {
  id: string;
  libraryId: string;
  systemIdentifier: string;
  title: string;
  md5: string | null;
  crc: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssetRecord {
  id: string;
  itemId: string;
  kind: AssetKind;
  displayName: string;
  relativePath: string;
  sha256: string;
  size: number;
  md5: string | null;
  crc: string | null;
  shareable: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  conflictOf: string | null;
}

/**
 * A save is the one asset a concurrent write must never discard, because the
 * bytes exist nowhere else once a device has moved on. These kinds are kept
 * side by side instead of refused.
 */
export function isSaveAssetKind(kind: AssetKind): boolean {
  return kind === 'save_state' || kind === 'battery_save';
}

export interface UserActor {
  kind: 'user';
  userId: string;
  username: string;
  isOwner: boolean;
  tokenKind: 'session' | 'device';
  deviceId: string | null;
  scopes: ItemPermission[];
  /**
   * Admitted by the local-network rule rather than a token. Read and write then
   * follow `scopes` alone, so the owner's library role cannot turn the whole
   * LAN into an administrator.
   */
  localTrust?: boolean;
}

export interface GuestActor {
  kind: 'guest';
  grantId: string;
  libraryId: string;
  itemId: string | null;
  capabilities: GuestCapability[];
}

export type Actor = UserActor | GuestActor;

export interface ContentStat {
  size: number;
}

export interface ContentReader {
  stat(): ContentStat;
  openFull(): Readable;
  openRange(start: number, endInclusive: number): Readable;
}

export interface VirtualEntry {
  entryId: string;
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  method: string;
  crc?: string | null;
}

export interface VirtualWindow {
  offset: number;
  length: number;
}

export interface MaterializeQuota {
  maxExpandedBytes: number;
  maxCompressionRatio: number;
  maxEntries: number;
  maxNesting: number;
  timeoutMs: number;
}

export type VirtualResolution =
  | { kind: 'range'; entry: VirtualEntry; offset: number }
  | { kind: 'bundle'; entry: VirtualEntry; bundleId: string }
  | { kind: 'expand'; entryId: string; remainder: string | null; path: string };

export interface VirtualArtifactBundle {
  version: string;
  files: { entryId: string; path: string; size: number; sha256: string }[];
}

export interface VirtualContentProvider {
  readonly format: string;
  materializeBundle?(
    filePath: string,
    bundleId: string,
    destinationDirectory: string,
    quota: MaterializeQuota,
    signal?: AbortSignal,
  ): Promise<VirtualArtifactBundle>;
  close?(): Promise<void>;
  inspect(
    filePath: string,
    quota: MaterializeQuota,
    window?: VirtualWindow,
  ): Promise<{ entries: VirtualEntry[] } | null>;
  resolve?(
    filePath: string,
    entryId: string,
    quota: MaterializeQuota,
  ): Promise<VirtualResolution | null>;
  materialize?(
    filePath: string,
    entryId: string,
    destination: string,
    quota: MaterializeQuota,
  ): Promise<{ sha256: string; size: number }>;
}

export interface AccessRequest {
  actor: Actor;
  action: ItemPermission;
  libraryId: string;
  itemId?: string;
  assetKind?: AssetKind;
  shareable?: boolean;
  membership?: LibraryRole | null;
  itemPermissions?: ItemPermission[];
}

export { detectRomSystem, isRomExtension, type RomSystemDetection } from '@ecs/protocol';
export type * from './workflows.js';
export type { AssetKind, GuestCapability, ItemPermission, LibraryRole };
