// Generated from packages/protocol/openapi/openapi.yaml. Do not edit.

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string | null;
  instance?: string | null;
  requestId?: string | null;
}

export interface Capabilities {
  protocol: ProtocolInfo;
  minClientVersion: string;
  features: FeatureFlags;
  limits: Limits;
  authentication: string[];
}

export interface ProtocolInfo {
  major: number;
  minor: number;
  path: string;
}

export interface FeatureFlags {
  rangeRequests: boolean;
  multiRange: boolean;
  resumableUploads: boolean;
  changeFeed: boolean;
  guestGrants: boolean;
  virtualFormats: string[];
  webdav: boolean;
  natTraversal: boolean;
}

export interface Limits {
  maxUploadBytes: number;
  maxPageSize: number;
}

export interface SystemSummary {
  identifier: string;
  name: string;
}

export interface SystemList {
  systems: SystemSummary[];
  closed: boolean;
}

export interface Library {
  id: string;
  name: string;
  ownerId: string;
  revision: number;
  createdAt: string;
}

export interface LibraryList {
  items: Library[];
  nextCursor: string | null;
}

export interface LibraryDraft {
  name: string;
}

export interface FolderEntry {
  name: string;
  path: string;
}

export interface FolderPlace {
  label: string;
  path: string;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  entries: FolderEntry[];
  places: FolderPlace[];
}

export interface ContentRoot {
  id: string;
  path: string;
  label: string;
  libraryId: string | null;
  createdAt: string;
}

export interface ContentRootList {
  items: ContentRoot[];
  nextCursor: string | null;
}

export interface ContentRootDraft {
  path: string;
  label: string;
  libraryId?: string | null;
}

export interface Item {
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

export interface ItemList {
  items: Item[];
  nextCursor: string | null;
}

export interface ItemDraft {
  libraryId: string;
  systemIdentifier: string;
  title: string;
  md5?: string | null;
  crc?: string | null;
}

export interface ItemPatch {
  title?: string;
  md5?: string | null;
  crc?: string | null;
}

export interface Asset {
  id: string;
  itemId: string;
  kind: string;
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
  conflictOf?: string | null;
}

export interface ManifestFile {
  id: string;
  kind: string;
  relativePath: string;
  sha256: string;
  md5: string | null;
  crc: string | null;
  size: number;
  required: boolean;
  contentPath: string;
}

export interface Manifest {
  version: number;
  itemId: string;
  revision: number;
  files: ManifestFile[];
}

export interface UploadSession {
  id: string;
  received: number;
  state: string;
}

export interface UploadComplete {
  itemId: string;
  kind: string;
  displayName: string;
  relativePath: string;
  baseRevision: number;
}

export interface ChangeEvent {
  cursor: number;
  entityType: string;
  entityId: string;
  op: string;
  libraryId: string | null;
  itemId: string | null;
  sensitive: boolean;
  recordedAt: string;
}

export interface ChangeList {
  changes: ChangeEvent[];
  nextCursor: string;
}

export interface BootstrapRequest {
  token: string;
  username: string;
  password: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface SessionResponse {
  token: string;
  tokenType: string;
  userId: string;
  expiresAt: string;
}

export interface UserDraft {
  username: string;
  password: string;
}

export interface User {
  id: string;
  username: string;
  isOwner: boolean;
  createdAt: string;
}

export interface MemberDraft {
  role: string;
}

export interface ItemAccessDraft {
  permission: string;
}

export interface GuestGrantDraft {
  libraryId: string;
  itemId?: string | null;
  capabilities: string[];
  expiresInSeconds: number;
}

export interface GuestGrantCreated {
  id: string;
  token: string;
  expiresAt: string;
}

export interface DeviceTokenDraft {
  name: string;
  scopes: string[];
  expiresInSeconds?: number | null;
}

export interface DeviceTokenCreated {
  id: string;
  token: string;
  scopes: string[];
}

export interface AuditEvent {
  id: number;
  at: string;
  actorId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
}

export interface AuditList {
  events: AuditEvent[];
}

export interface VirtualEntry {
  entryId: string;
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  method: string;
  crc?: string | null;
}

export interface VirtualEntryList {
  supported: boolean;
  entries: string[];
  format?: string | null;
  items?: VirtualEntry[];
}
