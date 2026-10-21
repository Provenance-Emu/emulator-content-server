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
  bootstrapped?: boolean;
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
  webPlayback?: boolean;
}

export interface PlayerCoreResource {
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface PlayerCoreDescriptor {
  version: number;
  id: string;
  name: string;
  systems: string[];
  runtime: string;
  threaded: boolean;
  filesystem: string;
  saveCompletion: string;
  frontendCommit: string;
  coreCommit: string;
  emscriptenVersion: string;
  contentExtension: string;
  maxContentBytes: number;
  loader: PlayerCoreResource;
  wasm: PlayerCoreResource;
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
  canCreateItems?: boolean;
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

export interface WebDavCredential {
  id: string;
  name: string;
  username: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface WebDavCredentialList {
  items: WebDavCredential[];
}

export interface WebDavCredentialDraft {
  name: string;
  expiresInSeconds?: number;
}

export interface WebDavCredentialCreated {
  credential: WebDavCredential;
  password: string;
}

export interface StorageLocation {
  id: string;
  path: string;
  label: string;
  createdAt: string;
  online: boolean;
}

export interface StorageLocationList {
  items: StorageLocation[];
  writeLocationId: string | null;
}

export interface StorageLocationDraft {
  path: string;
  label: string;
}

export interface StorageWriteTarget {
  id: string | null;
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

export interface ContentRootScan {
  rootId: string;
  medium: string;
  online: boolean;
  count: number;
}

export interface SourceFile {
  id: string;
  rootId: string;
  libraryId: string | null;
  name: string;
  kind: string;
  size: number;
  systemId: string | null;
  availability: string;
  medium: string;
  title?: string;
  artworkAvailable?: boolean;
  groupFileCount?: number;
  groupError?: string | null;
  contentPath: string;
}

export interface MatchingPlugin {
  id: string;
  name: string;
  kind: string;
  capabilities: string[];
  network: boolean;
}

export interface MatchingPluginList {
  plugins: MatchingPlugin[];
}

export interface MatchingOptions {
  online?: boolean;
  checksum?: boolean;
  providerIds?: string[];
  managerId?: string;
}

export interface MatchingCandidate {
  id: string;
  providerId: string;
  kind: string;
  title: string;
  confidence: string;
  metadata: Record<string, unknown>;
  fileId?: string;
  url?: string;
}

export interface SavedSourceMatch {
  id: string;
  providerId: string;
  kind: string;
  title: string;
  confidence: string;
  metadata: Record<string, unknown>;
  originFileId?: string;
  originUrl?: string;
  contentAvailable: boolean;
  contentType: string | null;
  fileName: string | null;
  updatedAt: string;
}

export interface SourceMatchSelections {
  sourceId: string;
  revision: number;
  matches: SavedSourceMatch[];
}

export interface SourceMatchSelectionDraft {
  requestId: string;
  candidateId: string;
  expectedRevision: number;
}

export interface MatchingProblem {
  providerId: string;
  code: string;
}

export interface SourceMatches {
  sourceId: string;
  requestId: string;
  plugins: MatchingPlugin[];
  candidates: MatchingCandidate[];
  problems: MatchingProblem[];
}

export interface SourceGroupFile {
  id: string;
  name: string;
  size: number;
  availability: string;
}

export interface SourceGroup {
  sourceId: string;
  error: string | null;
  files: SourceGroupFile[];
}

export interface SourceFileList {
  items: SourceFile[];
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
  conflictOf?: string | null;
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

export interface AccessPolicy {
  mode: string;
  subnets: string[];
  applies: boolean;
  trusted: boolean;
  manages: boolean;
}

export interface GuestGrant {
  id: string;
  libraryId: string;
  itemId?: string | null;
  capabilities: string[];
  expiresAt: string;
  createdAt: string;
  revokedAt?: string | null;
  createdBy?: string;
}

export interface GuestGrantList {
  items: GuestGrant[];
}

export interface RootLibraryAssignment {
  libraryId: string;
}

export interface LibraryBrowseEntry {
  entityType: string;
  id: string;
  name: string;
  libraryId: string | null;
  systemId: string | null;
  canUpload: boolean;
  canAdopt: boolean;
  item?: Item;
  asset?: Asset;
  source?: SourceFile;
  parentItem?: Item;
  previewAsset?: Asset;
}

export interface LibraryBrowsePage {
  items: LibraryBrowseEntry[];
  systemCounts?: SystemCount[];
  nextCursor: string | null;
}

export interface SystemCount {
  systemId: string;
  count: number;
}

export interface ContentRootSummary {
  root: ContentRoot;
  indexedFileCount: number;
  scanState: string;
  lastScanAt: string | null;
  lastCheckAt: string | null;
  online: boolean | null;
  medium: string | null;
}

export interface ContentRootSummaryList {
  items: ContentRootSummary[];
}
