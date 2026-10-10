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
}

export interface UserActor {
  kind: 'user';
  userId: string;
  username: string;
  isOwner: boolean;
  tokenKind: 'session' | 'device';
  scopes: ItemPermission[];
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
}

export interface MaterializeQuota {
  maxExpandedBytes: number;
  maxCompressionRatio: number;
  maxEntries: number;
  maxNesting: number;
  timeoutMs: number;
}

export interface VirtualEntryLocation {
  entry: VirtualEntry;
  sourceOffset: number | null;
}

export interface VirtualContentProvider {
  readonly format: string;
  inspect(filePath: string, quota: MaterializeQuota): Promise<{ entries: VirtualEntry[] } | null>;
  locate?(
    filePath: string,
    entryId: string,
    quota: MaterializeQuota,
  ): Promise<VirtualEntryLocation | null>;
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

export type { AssetKind, GuestCapability, ItemPermission, LibraryRole };
