import type {
  AccessPolicy,
  Asset,
  AuditList,
  Capabilities,
  ChangeList,
  ContentRoot,
  ContentRootDraft,
  ContentRootList,
  ContentRootScan,
  ContentRootSummaryList,
  DeviceTokenCreated,
  DeviceTokenDraft,
  DeviceTokenList,
  FolderListing,
  FolderWatchPolicy,
  FolderWatchPolicyDraft,
  GuestGrantCreated,
  GuestGrantDraft,
  GuestGrantList,
  Item,
  ItemDraft,
  ItemList,
  Library,
  LibraryBrowsePage,
  LibraryDraft,
  LibraryJobDraft,
  LibraryJobItemList,
  LibraryJobList,
  LibraryJobResponse,
  LibraryList,
  LibraryMemberList,
  Manifest,
  MatchingOptions,
  MatchingPluginList,
  PlayerConfiguration,
  PlayerCoreDescriptor,
  PlayerCoreResource,
  PlayerIsolationSession,
  PlayerManagement,
  Problem,
  SessionResponse,
  SourceFileList,
  SourceGroup,
  SourceMatches,
  SourceMatchSelections,
  SourceOrganizationDraft,
  SourceOrganizationPolicy,
  SourceOrganizationPolicyDraft,
  SourceOrganizationPreview,
  SourceOrganizationResult,
  StorageLocation,
  StorageLocationDraft,
  StorageLocationList,
  StorageWriteTarget,
  SystemList,
  UploadSession,
  User,
  UserDraft,
  WebDavCredentialCreated,
  WebDavCredentialDraft,
  WebDavCredentialList,
  WebPlayerCatalog,
  WebPlayerDescriptor,
} from './generated.js';
import { sha256Bytes } from './sha256.js';

export type LibraryScope = { libraryId: string } | { unassigned: true };
export type BrowseCategory = 'games' | 'saves' | 'media' | 'system_files';
export type BrowseSort = 'name_asc' | 'name_desc';
export type LibraryBrowseQuery = LibraryScope & {
  category: BrowseCategory;
  rootId?: string;
  systemId?: string;
  systemIds?: string[];
  search?: string;
  sort?: BrowseSort;
  cursor?: string;
  limit?: number;
};

export interface ResumePlan {
  offset: number;
  range: string | null;
}

export type DownloadInstruction = 'append' | 'restart' | 'not-modified' | 'unsatisfiable';

export function planResume(localBytes: number, totalBytes: number | null): ResumePlan {
  if (localBytes < 0 || (totalBytes !== null && localBytes > totalBytes)) {
    return { offset: 0, range: null };
  }
  if (localBytes === 0) return { offset: 0, range: null };
  return { offset: localBytes, range: `bytes=${localBytes}-` };
}

export function interpretDownload(status: number, requestedOffset: number): DownloadInstruction {
  if (status === 304) return 'not-modified';
  if (status === 416) return 'unsatisfiable';
  if (status === 200 && requestedOffset > 0) return 'restart';
  if (status === 206 || status === 200) return 'append';
  return 'restart';
}

/**
 * A request the server refused. The status and problem document are kept so a
 * caller can tell a stale revision from a missing asset without matching on
 * message text. Neither the token nor the authorization header is ever included.
 */
export class ContentError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | null,
  ) {
    super(problem?.title ?? `Content request failed with HTTP ${status}`);
    this.name = 'ContentError';
  }
}

/**
 * Bytes to upload. A `Blob` from `fs.openAsBlob` streams a large ROM off disk,
 * while a `Uint8Array` suits a save that is already in memory.
 */
export type UploadBody = Blob | Uint8Array;

export interface ChangeQuery {
  cursor?: string;
  limit?: number;
  /** Omits the changes this device caused, which is what stops a poll echoing. */
  excludeOwnDevice?: boolean;
}

export interface DownloadQuery {
  /** Bytes already held locally. The remainder is asked for as one range. */
  localBytes?: number;
  /** The ETag those bytes came from, so changed content restarts rather than appending. */
  etag?: string;
  signal?: AbortSignal;
}

export interface CollectOptions {
  attempts?: number;
  signal?: AbortSignal;
  /** Maximum whole body size, checked against headers and bytes before accepting them. */
  maxBytes?: number;
  /** Called as bytes arrive, with the whole size when the server states one. */
  onProgress?: (received: number, total: number | null) => void;
}

/** A caller-owned destination. Failed transfers abort instead of committing partial bytes. */
export interface DownloadSink {
  /** Resolve only after consuming the chunk; the client awaits this before writing more. */
  write(chunk: Uint8Array): Promise<void>;
  /** Truncate the destination and seek to its beginning. */
  reset(): Promise<void>;
  /** Commit only a complete, validated representation. */
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface CollectedAsset {
  /** A buffer allocated here, so a caller may hand it straight to a `Blob`. */
  bytes: Uint8Array<ArrayBuffer>;
  etag: string | null;
}

export interface DownloadResponse {
  instruction: DownloadInstruction;
  /** Where the body belongs in the local file, which is 0 unless appending. */
  offset: number;
  etag: string | null;
  totalBytes: number | null;
  body: ReadableStream<Uint8Array> | null;
}

export interface UploadRequest {
  libraryId: string;
  itemId: string;
  kind: string;
  displayName: string;
  relativePath: string;
  baseRevision: number;
  body: UploadBody;
  /** Resumes the session an interrupted attempt opened instead of starting over. */
  uploadId?: string;
  /** Replayed on retry, so a lost response cannot commit the same asset twice. */
  idempotencyKey?: string;
  /**
   * Sends the body in pieces of at most this many bytes instead of one request.
   * A break then costs the current piece rather than the whole transfer, and
   * `onProgress` has something to report. One request by default.
   */
  chunkBytes?: number;
  onProgress?: (sent: number, total: number) => void;
}

export class ContentClient {
  constructor(
    private readonly baseUrl: string,
    private token?: string,
  ) {}

  async browse(query: LibraryBrowseQuery, signal?: AbortSignal): Promise<LibraryBrowsePage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) params.set(key, String(value));
    const page = await this.getJson<LibraryBrowsePage>(
      `/api/v1/browse?${params}`,
      undefined,
      signal,
    );
    validateBrowsePage(page);
    return page;
  }

  browseLibraries(): Promise<LibraryList> {
    return this.getJson('/api/v1/browse-libraries');
  }
  createLibrary(draft: LibraryDraft): Promise<Library> {
    return this.post('/api/v1/libraries', draft);
  }
  async renameLibrary(id: string, patch: { name: string }, baseRevision: number): Promise<Library> {
    const response = await fetch(this.url(`/api/v1/libraries/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers: {
        ...this.headers(),
        'content-type': 'application/json',
        'if-match': `"rev-${baseRevision}"`,
      },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as Library;
  }
  rootSummaries(
    filter: { libraryId?: string; unassigned?: boolean } = {},
  ): Promise<ContentRootSummaryList> {
    const params = new URLSearchParams();
    if (filter.libraryId !== undefined) params.set('libraryId', filter.libraryId);
    if (filter.unassigned === true) params.set('unassigned', 'true');
    return this.getJson(`/api/v1/root-summaries${params.size ? `?${params}` : ''}`);
  }
  assignRoot(id: string, assignment: { libraryId: string }): Promise<ContentRoot> {
    return this.putJson(`/api/v1/roots/${encodeURIComponent(id)}/library`, assignment);
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  playerCore(): Promise<PlayerCoreDescriptor> {
    return this.getJson('/api/v1/player/core', 'error');
  }

  /** Authenticated immutable core snapshots; no descriptor URL is followed. */
  async playerCoreAssets(id: string): Promise<{ loader: CollectedAsset; wasm: CollectedAsset }> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid core identifier');
    const loader = await this.collectPath(`/play/cores/${id}/loader.js`, {
      maxBytes: 8 * 1024 * 1024,
    });
    const wasm = await this.collectPath(`/play/cores/${id}/core.wasm`, {
      maxBytes: 64 * 1024 * 1024,
    });
    return { loader, wasm };
  }

  async createPlayerIsolation(profileId: string): Promise<PlayerIsolationSession> {
    validatePlayerId(profileId);
    const response = await fetch(this.url('/api/v1/player/isolated-sessions'), {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ profileId }),
      redirect: 'error',
    });
    if (!response.ok) throw await failure(response);
    const session = (await response.json()) as PlayerIsolationSession;
    try {
      const url = new URL(session.url);
      if (
        !/^[a-f0-9]{48}$/.test(session.id) ||
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        !url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== `/${session.id}/dolphin-sandbox.html` ||
        url.href !== session.url ||
        typeof session.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(session.expiresAt))
      )
        throw new Error();
    } catch {
      throw new Error('Invalid isolated player session');
    }
    return session;
  }
  async closePlayerIsolation(id: string): Promise<void> {
    if (!/^[a-f0-9]{48}$/.test(id)) throw new Error('Invalid isolated player session');
    const response = await fetch(this.url(`/api/v1/player/isolated-sessions/${id}`), {
      method: 'DELETE',
      keepalive: true,
      headers: this.headers(),
      redirect: 'error',
    });
    if (!response.ok) throw await failure(response);
  }

  playerManagement(): Promise<PlayerManagement> {
    return this.getJson('/api/v1/player/management', 'error');
  }
  installPlayer(id: string): Promise<PlayerManagement> {
    validatePlayerId(id);
    return this.playerInstallRequest(id);
  }
  private async playerInstallRequest(id: string): Promise<PlayerManagement> {
    const response = await fetch(this.url(`/api/v1/player/management/install/${id}`), {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: '{}',
      redirect: 'error',
    });
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<PlayerManagement>;
  }
  configurePlayer(id: string, configuration: PlayerConfiguration): Promise<PlayerManagement> {
    validatePlayerId(id);
    return this.playerConfigurationRequest(id, configuration);
  }
  private async playerConfigurationRequest(
    id: string,
    body: PlayerConfiguration,
  ): Promise<PlayerManagement> {
    const response = await fetch(this.url(`/api/v1/player/management/${id}`), {
      method: 'PATCH',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
    });
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<PlayerManagement>;
  }
  async removePlayer(id: string): Promise<PlayerManagement> {
    validatePlayerId(id);
    const response = await fetch(this.url(`/api/v1/player/management/${id}`), {
      method: 'DELETE',
      headers: this.headers(),
      redirect: 'error',
    });
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<PlayerManagement>;
  }
  async installPlayerSystemFile(id: string, name: string, file: Blob): Promise<PlayerManagement> {
    validatePlayerId(id);
    if (!isPlayerSystemFileName(name) || file.size < 1 || file.size > 32 * 1024 * 1024)
      throw new Error('Select a portable system filename and a file from 1 byte to 32 MiB');
    const response = await fetch(
      this.url(`/api/v1/player/management/${id}/system/${encodeURIComponent(name)}`),
      {
        method: 'PUT',
        headers: { ...this.headers(), 'content-type': 'application/vnd.ecs.player-system-file' },
        body: file,
        redirect: 'error',
      },
    );
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<PlayerManagement>;
  }
  async installPlayerPackage(file: Blob): Promise<PlayerManagement> {
    if (file.size < 4 || file.size > 104 * 1024 * 1024 + 65540)
      throw new Error('Emulator package exceeds supported size');
    const response = await fetch(this.url('/api/v1/player/management/install'), {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/vnd.ecs.player-package' },
      body: file,
      redirect: 'error',
    });
    if (!response.ok) throw await failure(response);
    return response.json() as Promise<PlayerManagement>;
  }

  async playerProfiles(): Promise<WebPlayerCatalog> {
    const catalog = await this.getJson<WebPlayerCatalog>('/api/v1/player/profiles', 'error');
    if (!catalog || !Array.isArray(catalog.items) || catalog.items.length > 64)
      throw new Error('Invalid player catalog');
    for (const p of catalog.items) validatePlayerProfile(p, p.id);
    const ids = new Set(catalog.items.map((p) => p.id));
    if (
      ids.size !== catalog.items.length ||
      (catalog.defaultProfileId !== null && !ids.has(catalog.defaultProfileId))
    )
      throw new Error('Invalid player catalog default or duplicate identifier');
    return catalog;
  }

  async playerProfile(id: string): Promise<WebPlayerDescriptor> {
    validatePlayerId(id);
    const descriptor = await this.getJson<WebPlayerDescriptor>(
      `/api/v1/player/profiles/${id}`,
      'error',
    );
    validatePlayerProfile(descriptor, id);
    return descriptor;
  }

  /** Fetch only fixed authenticated routes, verify every byte, and never follow descriptor URLs. */
  async playerProfileAssets(id: string): Promise<{
    loader: CollectedAsset;
    wasm: CollectedAsset;
    assets: { name: string; bytes: Uint8Array<ArrayBuffer> }[];
  }> {
    const p = await this.playerProfile(id);
    const base = `/play/plugins/${id}`;
    const read = async (resource: PlayerCoreResource, path: string) => {
      const asset = await this.collectPath(path, { maxBytes: resource.sizeBytes, attempts: 1 });
      const sha256 = await sha256Bytes(asset.bytes);
      if (asset.bytes.byteLength !== resource.sizeBytes || sha256 !== resource.sha256)
        throw new Error('Player resource size or SHA-256 mismatch');
      return asset;
    };
    const loader = await read(p.loader, `${base}/loader.js`);
    const wasm = await read(p.wasm, `${base}/core.wasm`);
    const assets = [];
    for (const spec of p.assets)
      assets.push({
        name: spec.name,
        bytes: (await read(spec, `${base}/assets/${spec.name}`)).bytes,
      });
    return { loader, wasm, assets };
  }

  /** Reads only a typed source endpoint, with the same resume guarantees as assets. */
  collectSource(sourceId: string, options: CollectOptions = {}): Promise<CollectedAsset> {
    return this.collectPath(`/api/v1/sources/${encodeURIComponent(sourceId)}/content`, options);
  }

  capabilities(): Promise<Capabilities> {
    return this.getJson('/api/v1/capabilities');
  }

  /** Unauthenticated liveness, which is what a menu-bar indicator polls. */
  health(): Promise<{ ok: boolean }> {
    return this.getJson('/health');
  }

  /** Creates the owner account. The bootstrap token is printed when the server first starts. */
  async bootstrap(token: string, username: string, password: string): Promise<SessionResponse> {
    const session = await this.post<SessionResponse>('/api/v1/auth/bootstrap', {
      token,
      username,
      password,
    });
    this.setToken(session.token);
    return session;
  }

  /** Signs in and keeps the returned token for later calls. */
  async login(username: string, password: string): Promise<SessionResponse> {
    const session = await this.post<SessionResponse>('/api/v1/auth/login', {
      username,
      password,
    });
    this.setToken(session.token);
    return session;
  }

  /** Who may use the server without a token, including whether this connection may. */
  access(): Promise<AccessPolicy> {
    return this.getJson('/api/v1/access');
  }

  setAccess(policy: { mode: string; subnets: string[] }): Promise<AccessPolicy> {
    return this.putJson('/api/v1/access', policy);
  }

  users(): Promise<{ items: User[] }> {
    return this.getJson('/api/v1/users');
  }

  createUser(draft: UserDraft): Promise<User> {
    return this.post('/api/v1/users', draft);
  }

  /** Replaces a password. The value is not returned and is not written to the audit log. */
  async setPassword(userId: string, password: string): Promise<void> {
    const response = await fetch(this.url(`/api/v1/users/${encodeURIComponent(userId)}`), {
      method: 'PATCH',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) throw await failure(response);
  }

  /** Grants without their tokens. The secret is only present on the create response. */
  guestGrants(limit?: number): Promise<GuestGrantList> {
    const search = limit !== undefined ? `?limit=${limit}` : '';
    return this.getJson(`/api/v1/guest-grants${search}`);
  }

  createGuestGrant(draft: GuestGrantDraft): Promise<GuestGrantCreated> {
    return this.post('/api/v1/guest-grants', draft);
  }

  revokeGuestGrant(grantId: string): Promise<void> {
    return this.remove(`/api/v1/guest-grants/${encodeURIComponent(grantId)}`);
  }

  libraryMembers(libraryId: string): Promise<LibraryMemberList> {
    return this.getJson(`/api/v1/libraries/${encodeURIComponent(libraryId)}/members`);
  }

  assignMember(libraryId: string, userId: string, role: string): Promise<void> {
    return this.putEmpty(
      `/api/v1/libraries/${encodeURIComponent(libraryId)}/members/${encodeURIComponent(userId)}`,
      { role },
    );
  }

  removeMember(libraryId: string, userId: string): Promise<void> {
    return this.remove(
      `/api/v1/libraries/${encodeURIComponent(libraryId)}/members/${encodeURIComponent(userId)}`,
    );
  }

  /** Revokes the token on the server before forgetting it here. */
  async logout(): Promise<void> {
    await this.post<unknown>('/api/v1/auth/logout', {});
    this.setToken(undefined);
  }

  libraries(cursor?: string): Promise<LibraryList> {
    return this.getJson(
      `/api/v1/libraries${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
  }

  /** The system identifiers this server accepts, which a create form offers. */
  systems(): Promise<SystemList> {
    return this.getJson('/api/v1/systems');
  }

  createItem(draft: ItemDraft): Promise<Item> {
    return this.post<Item>('/api/v1/items', draft);
  }

  items(query: { libraryId?: string; cursor?: string; limit?: number } = {}): Promise<ItemList> {
    const search = new URLSearchParams();
    if (query.libraryId) search.set('libraryId', query.libraryId);
    if (query.cursor) search.set('cursor', query.cursor);
    if (query.limit !== undefined) search.set('limit', String(query.limit));
    return this.getJson(`/api/v1/items?${search.toString()}`);
  }

  /**
   * Saved source folders. The caller submits a path and the server resolves it,
   * so a browser never reads the filesystem to manage one.
   */
  /**
   * Directories inside one folder on the machine running the server, which is
   * not necessarily this one. Pass null to start where the server suggests.
   */
  folders(path: string | null): Promise<FolderListing> {
    const search = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.getJson(`/api/v1/folders${search}`);
  }

  /** Owner-only storage administration. Paths are on the server, not the client. */
  deviceTokens(): Promise<DeviceTokenList> {
    return this.getJson('/api/v1/device-tokens');
  }

  createDeviceToken(draft: DeviceTokenDraft): Promise<DeviceTokenCreated> {
    return this.post('/api/v1/device-tokens', draft);
  }

  revokeDeviceToken(id: string): Promise<void> {
    return this.remove(`/api/v1/device-tokens/${encodeURIComponent(id)}`);
  }

  webdavCredentials(): Promise<WebDavCredentialList> {
    return this.getJson('/api/v1/webdav-credentials');
  }

  createWebdavCredential(draft: WebDavCredentialDraft): Promise<WebDavCredentialCreated> {
    return this.post('/api/v1/webdav-credentials', draft);
  }

  revokeWebdavCredential(id: string): Promise<void> {
    return this.remove(`/api/v1/webdav-credentials/${encodeURIComponent(id)}`);
  }

  storageLocations(): Promise<StorageLocationList> {
    return this.getJson('/api/v1/storage-locations');
  }

  addStorageLocation(draft: StorageLocationDraft): Promise<StorageLocation> {
    return this.post<StorageLocation>('/api/v1/storage-locations', draft);
  }

  setStorageWriteTarget(id: string | null): Promise<StorageWriteTarget> {
    return this.putJson('/api/v1/storage-locations/write-target', { id });
  }

  removeStorageLocation(id: string): Promise<void> {
    return this.remove(`/api/v1/storage-locations/${encodeURIComponent(id)}`);
  }

  roots(): Promise<ContentRootList> {
    return this.getJson('/api/v1/roots');
  }

  addRoot(draft: ContentRootDraft): Promise<ContentRoot> {
    return this.post<ContentRoot>('/api/v1/roots', draft);
  }

  removeRoot(rootId: string): Promise<void> {
    return this.remove(`/api/v1/roots/${rootId}`);
  }

  /** Reads a registered folder in place and records each file without copying it. */
  scanRoot(rootId: string): Promise<ContentRootScan> {
    return this.post<ContentRootScan>(`/api/v1/roots/${rootId}/scan`, {});
  }

  /** Files found by a scan. The response names them and does not include a filesystem path. */
  sources(): Promise<SourceFileList> {
    return this.getJson('/api/v1/sources');
  }

  createLibraryJob(draft: LibraryJobDraft): Promise<LibraryJobResponse> {
    return this.post('/api/v1/library-jobs', draft);
  }
  libraryJob(id: string): Promise<LibraryJobResponse> {
    return this.getJson(`/api/v1/library-jobs/${encodeURIComponent(id)}`);
  }
  libraryJobs(query: { limit?: number; cursor?: string } = {}): Promise<LibraryJobList> {
    const search = new URLSearchParams();
    if (query.limit) search.set('limit', String(query.limit));
    if (query.cursor) search.set('cursor', query.cursor);
    return this.getJson(`/api/v1/library-jobs?${search}`);
  }
  libraryJobItems(
    id: string,
    query: { limit?: number; cursor?: string; status?: string } = {},
  ): Promise<LibraryJobItemList> {
    const search = new URLSearchParams();
    if (query.limit) search.set('limit', String(query.limit));
    if (query.cursor) search.set('cursor', query.cursor);
    if (query.status) search.set('status', query.status);
    return this.getJson(`/api/v1/library-jobs/${encodeURIComponent(id)}/items?${search}`);
  }
  reviewLibraryJobItem(id: string, sourceId: string): Promise<LibraryJobResponse> {
    return this.post(
      `/api/v1/library-jobs/${encodeURIComponent(id)}/items/${encodeURIComponent(sourceId)}/reviewed`,
      {},
    );
  }
  cancelLibraryJob(id: string): Promise<LibraryJobResponse> {
    return this.post(`/api/v1/library-jobs/${encodeURIComponent(id)}/cancel`, {});
  }
  resumeLibraryJob(id: string, retry?: 'failed' | 'unmatched'): Promise<LibraryJobResponse> {
    return this.post(
      `/api/v1/library-jobs/${encodeURIComponent(id)}/resume`,
      retry ? { retry } : {},
    );
  }

  async sourceSelections(id: string, signal?: AbortSignal): Promise<SourceMatchSelections> {
    return this.selectionRequest(id, { method: 'GET', signal });
  }
  async saveSourceMatch(
    id: string,
    requestId: string,
    candidateId: string,
    expectedRevision: number,
    signal?: AbortSignal,
  ): Promise<SourceMatchSelections> {
    return this.selectionRequest(id, {
      method: 'PUT',
      body: JSON.stringify({ requestId, candidateId, expectedRevision }),
      signal,
    });
  }
  async removeSourceMatch(
    id: string,
    kind: string,
    revision: number,
    signal?: AbortSignal,
    artworkRole?: string,
  ): Promise<SourceMatchSelections> {
    const query = new URLSearchParams();
    if (artworkRole !== undefined) query.set('artworkRole', artworkRole);
    return this.selectionRequest(
      id,
      { method: 'DELETE', headers: { 'if-match': `"rev-${revision}"` }, signal },
      `/${encodeURIComponent(kind)}${query.size ? `?${query}` : ''}`,
    );
  }
  private async selectionRequest(
    id: string,
    init: RequestInit,
    suffix = '',
  ): Promise<SourceMatchSelections> {
    const url = this.url(`/api/v1/sources/${encodeURIComponent(id)}/matches/selections${suffix}`);
    url.searchParams.set('includeArtworkRoles', 'true');
    const response = await fetch(url, {
      ...init,
      headers: {
        ...this.headers(),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw await failure(response);
    const result = (await response.json()) as SourceMatchSelections;
    if (
      result.sourceId !== id ||
      !Number.isSafeInteger(result.revision) ||
      result.revision < 0 ||
      !Array.isArray(result.matches) ||
      result.matches.length > 11
    )
      throw new Error('Invalid saved matches');
    const selections = new Set<string>();
    for (const match of result.matches) {
      const role = match?.kind === 'artwork' ? (match.artworkRole ?? 'front') : '';
      const key = `${match?.kind}:${role}`;
      if (
        !match ||
        typeof match.id !== 'string' ||
        typeof match.providerId !== 'string' ||
        !['rom', 'metadata', 'artwork', 'patch', 'cheats'].includes(match.kind) ||
        (match.kind === 'artwork' &&
          match.artworkRole !== undefined &&
          !['front', 'back', 'disc', 'manual', 'title', 'screenshot', 'other'].includes(
            match.artworkRole,
          )) ||
        (match.kind !== 'artwork' && match.artworkRole !== undefined) ||
        selections.has(key) ||
        typeof match.title !== 'string' ||
        match.title.length > 512 ||
        !match.metadata ||
        typeof match.metadata !== 'object' ||
        Array.isArray(match.metadata) ||
        Object.keys(match.metadata).length > 24 ||
        Object.values(match.metadata).some((v) => typeof v !== 'string' || v.length > 4096) ||
        typeof match.contentAvailable !== 'boolean' ||
        (match.fileName !== null && typeof match.fileName !== 'string') ||
        (match.contentType !== null && typeof match.contentType !== 'string')
      )
        throw new Error('Invalid saved match');
      selections.add(key);
    }
    return result;
  }
  async selectedMatchContent(
    id: string,
    kind: string,
    signal?: AbortSignal,
    artworkRole?: string,
  ): Promise<Blob> {
    const url = this.url(
      `/api/v1/sources/${encodeURIComponent(id)}/matches/selections/${encodeURIComponent(kind)}/content`,
    );
    if (artworkRole !== undefined) url.searchParams.set('artworkRole', artworkRole);
    const response = await fetch(url, { headers: this.headers(), signal });
    if (!response.ok) throw await failure(response);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Selected file unavailable');
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > (kind === 'artwork' && artworkRole === 'manual' ? 8 : 2) * 1024 * 1024)
          throw new Error('Selected file too large');
        chunks.push(new Uint8Array(part.value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return new Blob(chunks, {
      type: response.headers.get('content-type') ?? 'application/octet-stream',
    });
  }

  folderWatchPolicy(rootId: string): Promise<FolderWatchPolicy> {
    return this.getJson(`/api/v1/roots/${encodeURIComponent(rootId)}/watching-policy`);
  }

  setFolderWatchPolicy(rootId: string, draft: FolderWatchPolicyDraft): Promise<FolderWatchPolicy> {
    return this.putJson(`/api/v1/roots/${encodeURIComponent(rootId)}/watching-policy`, draft);
  }

  sourceOrganizationPolicy(rootId: string): Promise<SourceOrganizationPolicy> {
    return this.getJson(`/api/v1/roots/${encodeURIComponent(rootId)}/organization-policy`);
  }
  setSourceOrganizationPolicy(
    rootId: string,
    draft: SourceOrganizationPolicyDraft,
  ): Promise<SourceOrganizationPolicy> {
    return this.putJson(`/api/v1/roots/${encodeURIComponent(rootId)}/organization-policy`, draft);
  }

  previewSourceOrganization(
    id: string,
    draft: SourceOrganizationDraft,
  ): Promise<SourceOrganizationPreview> {
    return this.post(`/api/v1/sources/${encodeURIComponent(id)}/organization/preview`, draft);
  }

  applySourceOrganization(id: string, planId: string): Promise<SourceOrganizationResult> {
    return this.post(`/api/v1/sources/${encodeURIComponent(id)}/organization/apply`, { planId });
  }

  async matchingPlugins(): Promise<MatchingPluginList> {
    const result = await this.getJson<MatchingPluginList>('/api/v1/matching/plugins');
    if (!Array.isArray(result.plugins) || result.plugins.length > 64)
      throw new Error('Invalid plugin registry');
    return result;
  }

  async sourceMatches(
    id: string,
    options: MatchingOptions = {},
    signal?: AbortSignal,
  ): Promise<SourceMatches> {
    const response = await fetch(this.url(`/api/v1/sources/${encodeURIComponent(id)}/matches`), {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(options),
      signal,
    });
    if (!response.ok) throw await failure(response);
    const result = (await response.json()) as SourceMatches;
    if (
      result.sourceId !== id ||
      typeof result.requestId !== 'string' ||
      !Array.isArray(result.candidates) ||
      result.candidates.length > 100 ||
      !Array.isArray(result.plugins) ||
      result.plugins.length > 64 ||
      !Array.isArray(result.problems)
    )
      throw new Error('Invalid matching response');
    const ids = new Set<string>();
    for (const c of result.candidates) {
      if (
        !c ||
        typeof c.id !== 'string' ||
        ids.has(c.id) ||
        typeof c.providerId !== 'string' ||
        !['rom', 'metadata', 'artwork', 'patch', 'cheats'].includes(c.kind) ||
        typeof c.title !== 'string' ||
        c.title.length > 512 ||
        !['checksum', 'local', 'name'].includes(c.confidence) ||
        !c.metadata ||
        typeof c.metadata !== 'object' ||
        Array.isArray(c.metadata) ||
        Object.keys(c.metadata).length > 24 ||
        Object.values(c.metadata).some((v) => typeof v !== 'string' || v.length > 4096)
      )
        throw new Error('Invalid matching candidate');
      ids.add(c.id);
    }
    return result;
  }

  async matchingArtwork(
    sourceId: string,
    requestId: string,
    candidateId: string,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const response = await fetch(
      this.url(
        `/api/v1/sources/${encodeURIComponent(sourceId)}/matches/${encodeURIComponent(requestId)}/artwork/${encodeURIComponent(candidateId)}`,
      ),
      { headers: this.headers(), signal },
    );
    if (!response.ok) throw await failure(response);
    const type = response.headers.get('content-type')?.split(';')[0];
    if (!type || !['image/png', 'image/jpeg', 'image/webp'].includes(type))
      throw new Error('Unsupported artwork');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Artwork unavailable');
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) break;
        size += read.value.byteLength;
        if (size > 2 * 1024 * 1024) throw new Error('Artwork too large');
        chunks.push(new Uint8Array(read.value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return new Blob(chunks, { type });
  }

  async sourceGroup(id: string): Promise<SourceGroup> {
    const group = await this.getJson<SourceGroup>(
      `/api/v1/sources/${encodeURIComponent(id)}/group`,
    );
    if (
      group.sourceId !== id ||
      !Array.isArray(group.files) ||
      group.files.length > 512 ||
      group.files.some(
        (file) =>
          !file ||
          typeof file.id !== 'string' ||
          typeof file.name !== 'string' ||
          (file.relativePath !== undefined &&
            (typeof file.relativePath !== 'string' || file.relativePath.length > 4096)) ||
          typeof file.availability !== 'string' ||
          !Number.isSafeInteger(file.size) ||
          file.size < 0,
      ) ||
      new Set(group.files.map((file) => file.id)).size !== group.files.length ||
      !(group.error === null || typeof group.error === 'string')
    )
      throw new TypeError('Invalid source group');
    return group;
  }
  async sourceBundle(id: string, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(this.url(`/api/v1/sources/${encodeURIComponent(id)}/bundle`), {
      headers: { ...this.headers(), accept: 'application/zip' },
      signal,
    });
    if (!response.ok) throw await failure(response);
    return response;
  }

  /** Owner audit. Detail JSON, which is where a secret could hide, is not returned. */
  audit(limit?: number): Promise<AuditList> {
    const search = limit !== undefined ? `?limit=${limit}` : '';
    return this.getJson(`/api/v1/audit${search}`);
  }

  manifest(itemId: string): Promise<Manifest> {
    return this.getJson(`/api/v1/items/${itemId}/manifest`);
  }

  asset(assetId: string): Promise<Asset> {
    return this.getJson(`/api/v1/files/${assetId}`);
  }

  /**
   * Makes a conflict copy the live save at its path. The bytes that were live
   * stay beside it, so choosing one never discards the other.
   */
  adopt(assetId: string): Promise<Asset> {
    return this.post<Asset>(`/api/v1/files/${assetId}/adopt`, {});
  }

  changes(query: ChangeQuery = {}): Promise<ChangeList> {
    const search = new URLSearchParams();
    if (query.cursor !== undefined) search.set('cursor', query.cursor);
    if (query.limit !== undefined) search.set('limit', String(query.limit));
    if (query.excludeOwnDevice) search.set('excludeOwnDevice', '1');
    return this.getJson(`/api/v1/changes?${search.toString()}`);
  }

  /**
   * Walks the feed from `query.cursor` until it is caught up, yielding every
   * page so the caller can persist `nextCursor` as it applies one. A page that
   * does not advance the cursor is the last, which is how a feed that is already
   * current costs one request instead of looping.
   */
  async *changePages(query: ChangeQuery = {}): AsyncGenerator<ChangeList> {
    let cursor = query.cursor ?? '0';
    for (;;) {
      const page = await this.changes({ ...query, cursor });
      yield page;
      if (page.nextCursor === cursor) return;
      cursor = page.nextCursor;
    }
  }

  /**
   * Asks for an asset from `localBytes` onward and leaves the body to the
   * caller, which is what keeps this package free of a filesystem.
   */
  async download(assetId: string, query: DownloadQuery = {}): Promise<DownloadResponse> {
    return this.downloadPath(`/api/v1/files/${encodeURIComponent(assetId)}/content`, query);
  }

  private async downloadPath(
    path: string,
    query: DownloadQuery,
  ): Promise<DownloadResponse & { bodyBytes: number | null; status: number }> {
    const plan = planResume(query.localBytes ?? 0, null);
    const headers = this.headers();
    if (plan.range) {
      headers.range = plan.range;
      if (query.etag) headers['if-range'] = query.etag;
    }
    const response = await fetch(this.url(path), {
      headers,
      redirect: 'error',
      signal: query.signal,
    });
    if (!response.ok && response.status !== 304 && response.status !== 416)
      throw await failure(response);
    let total: number | null;
    let bodyBytes: number | null = null;
    try {
      query.signal?.throwIfAborted();
      total = totalBytes(response);
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers.get('content-range') ?? '',
        );
        const start = Number(range?.[1]);
        const end = Number(range?.[2]);
        const length = response.headers.get('content-length');
        if (
          !range ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start !== plan.offset ||
          end < start ||
          total === null ||
          end >= total ||
          (length !== null && Number(length) !== end - start + 1)
        ) {
          throw new RangeError('Invalid content range or length');
        }
        bodyBytes = end - start + 1;
        if (query.etag && response.headers.get('etag') !== query.etag) {
          throw new DownloadChangedError('Content validator changed during resumed download');
        }
      }
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const instruction = interpretDownload(response.status, plan.offset);
    const carriesContent = instruction === 'append' || instruction === 'restart';
    if (!carriesContent) await response.body?.cancel().catch(() => undefined);
    return {
      instruction,
      offset: instruction === 'append' ? plan.offset : 0,
      etag: response.headers.get('etag'),
      totalBytes: total,
      bodyBytes,
      status: response.status,
      body: carriesContent ? response.body : null,
    };
  }

  /**
   * Reads an asset whole, asking only for the bytes still missing when a stream
   * breaks part way. Content that changed under the transfer comes back as a
   * restart, and what had been collected is discarded rather than spliced into
   * bytes from a different revision.
   *
   * Holding the result in memory is the caller's budget. A client with a
   * filesystem should use `downloadTo` to write with backpressure instead.
   */
  collect(assetId: string, options: CollectOptions = {}): Promise<CollectedAsset> {
    return this.collectPath(`/api/v1/files/${encodeURIComponent(assetId)}/content`, options);
  }

  /** Stream an asset to a destination without collecting its body in memory. */
  downloadTo(assetId: string, sink: DownloadSink, options: CollectOptions = {}): Promise<void> {
    return this.downloadToPath(
      `/api/v1/files/${encodeURIComponent(assetId)}/content`,
      sink,
      options,
    );
  }

  /** Stream only the typed source endpoint; no descriptor-provided URL is followed. */
  downloadSourceTo(
    sourceId: string,
    sink: DownloadSink,
    options: CollectOptions = {},
  ): Promise<void> {
    return this.downloadToPath(
      `/api/v1/sources/${encodeURIComponent(sourceId)}/content`,
      sink,
      options,
    );
  }

  private async downloadToPath(
    path: string,
    sink: DownloadSink,
    options: CollectOptions,
  ): Promise<void> {
    const attempts = options.attempts ?? 3;
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    let received = 0;
    let etag: string | undefined;
    let total: number | null = null;
    let restart = false;
    // A destination may have written partially before throwing. Never replay its operations.
    let consumerFailed = false;
    const consume = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        consumerFailed = true;
        throw error;
      }
    };
    try {
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0 ||
        !Number.isSafeInteger(attempts) ||
        attempts < 1
      )
        throw new RangeError('Invalid download byte limit or attempts');
      options.signal?.throwIfAborted();
      await consume(() => sink.reset());
      for (let attempt = 1; ; attempt++) {
        try {
          options.signal?.throwIfAborted();
          if (restart || (received > 0 && (!etag || !/^"[^"\r\n]*"$/.test(etag)))) {
            await consume(() => sink.reset());
            received = 0;
            etag = undefined;
            total = null;
            restart = false;
          }
          const response = await this.downloadPath(path, {
            localBytes: received,
            etag,
            signal: options.signal,
          });
          if (response.status !== 200 && response.status !== 206) {
            await response.body?.cancel().catch(() => undefined);
            throw new RangeError('Cannot download a complete representation from this response');
          }
          if (response.totalBytes !== null && response.totalBytes > maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw new RangeError('Content exceeds maximum byte limit');
          }
          if (response.instruction === 'restart') {
            // A successful full response supersedes the previous prefix, even with the same ETag.
            try {
              await consume(() => sink.reset());
            } catch (error) {
              await response.body?.cancel().catch(() => undefined);
              throw error;
            }
            received = 0;
            total = null;
          }
          if (received > 0 && total !== null && response.totalBytes !== total) {
            await response.body?.cancel().catch(() => undefined);
            throw new RangeError('Content size changed without a changed validator');
          }
          total = response.totalBytes;
          etag = response.etag ?? undefined;
          let bodyReceived = 0;
          // Progress callbacks are consumer code too; a thrown callback is not a network failure.
          try {
            await consume(() => options.onProgress?.(received, total));
            for await (const chunk of chunks(response.body, options.signal)) {
              if (
                response.bodyBytes !== null &&
                chunk.byteLength > response.bodyBytes - bodyReceived
              )
                throw new RangeError('Content body exceeds the declared range length');
              if (chunk.byteLength > maxBytes - received)
                throw new RangeError('Content exceeds maximum byte limit');
              if (total !== null && chunk.byteLength > total - received)
                throw new RangeError('Content body exceeds the declared total size');
              // Views avoid a second body allocation and bound each pending destination write.
              for (let offset = 0; offset < chunk.byteLength; offset += 64 * 1024) {
                options.signal?.throwIfAborted();
                const part = chunk.subarray(offset, offset + 64 * 1024);
                await consume(() => sink.write(part));
                received += part.byteLength;
                await consume(() => options.onProgress?.(received, total));
              }
              bodyReceived += chunk.byteLength;
            }
          } catch (error) {
            if (!response.body?.locked) await response.body?.cancel().catch(() => undefined);
            throw error;
          }
          if (response.bodyBytes !== null && bodyReceived !== response.bodyBytes)
            throw new RangeError('Content body ended before the declared range length');
          if (total !== null && received !== total)
            throw new Error('The asset body ended before the size the server stated');
          options.signal?.throwIfAborted();
          await consume(() => sink.close());
          return;
        } catch (error) {
          if (
            consumerFailed ||
            options.signal?.aborted ||
            attempt >= attempts ||
            !isRetryable(error)
          )
            throw error;
          if (error instanceof DownloadChangedError) restart = true;
        }
      }
    } catch (error) {
      // Preserve the cause even if cleaning up the destination also fails.
      try {
        await sink.abort(error);
      } catch {
        /* Keep the original failure. */
      }
      throw error;
    }
  }

  private async collectPath(path: string, options: CollectOptions): Promise<CollectedAsset> {
    const attempts = options.attempts ?? 3;
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      !Number.isSafeInteger(attempts) ||
      attempts < 1
    ) {
      throw new RangeError('Invalid collection byte limit or attempts');
    }
    let held: Uint8Array[] = [];
    let received = 0;
    let etag: string | undefined;
    for (let attempt = 1; ; attempt += 1) {
      try {
        // Partial bytes without a strong validator cannot safely be spliced together.
        if (received > 0 && (!etag || !/^"[^"\r\n]*"$/.test(etag))) {
          held = [];
          received = 0;
          etag = undefined;
        }
        options.signal?.throwIfAborted();
        const response = await this.downloadPath(path, {
          localBytes: received,
          etag,
          signal: options.signal,
        });
        if (response.instruction === 'not-modified' || response.instruction === 'unsatisfiable') {
          throw new RangeError(
            'Cannot collect a complete representation from a response without a body',
          );
        }
        if (response.totalBytes !== null && response.totalBytes > maxBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new RangeError('Content exceeds maximum byte limit');
        }
        if (response.instruction !== 'append') {
          held = [];
          received = 0;
        }
        etag = response.etag ?? undefined;
        options.onProgress?.(received, response.totalBytes);
        let bodyReceived = 0;
        for await (const chunk of chunks(response.body, options.signal)) {
          if (response.bodyBytes !== null && chunk.byteLength > response.bodyBytes - bodyReceived) {
            throw new RangeError('Content body exceeds the declared range length');
          }
          if (chunk.byteLength > maxBytes - received)
            throw new RangeError('Content exceeds maximum byte limit');
          held.push(chunk.slice());
          bodyReceived += chunk.byteLength;
          received += chunk.byteLength;
          options.onProgress?.(received, response.totalBytes);
        }
        if (response.bodyBytes !== null && bodyReceived !== response.bodyBytes) {
          throw new RangeError('Content body ended before the declared range length');
        }
        if (response.totalBytes !== null && received !== response.totalBytes) {
          throw new Error('The asset body ended before the size the server stated');
        }
        return { bytes: concat(held, received), etag: etag ?? null };
      } catch (error) {
        if (options.signal?.aborted || attempt >= attempts || !isRetryable(error)) throw error;
      }
    }
  }

  /**
   * Sends the bytes and commits the asset, resuming from the offset the server
   * admits to holding. A retry re-reads that offset instead of assuming the
   * failed attempt wrote nothing, and the completion key is replayed so a lost
   * response cannot commit twice.
   */
  async upload(request: UploadRequest, attempts = 3): Promise<Asset> {
    const key = request.idempotencyKey ?? crypto.randomUUID();
    const uploadId =
      request.uploadId ?? (await this.openUpload(request.libraryId, `${key}.open`)).id;
    // An idempotent open replays its original receipt. Its offset may predate
    // transferred bytes or even completion, so only the live session is authoritative.
    const session = await this.uploadSession(uploadId);
    const total = sizeOf(request.body);
    const offset = (current: UploadSession): number => {
      if (
        current.id !== uploadId ||
        !Number.isSafeInteger(current.received) ||
        current.received < 0 ||
        current.received > total ||
        (current.state !== 'open' && current.state !== 'completed') ||
        (current.state === 'completed' && current.received !== total)
      )
        throw new RangeError('Invalid upload session offset or state');
      return current.received;
    };
    let received = offset(session);
    const piece = request.chunkBytes ?? total;
    for (let attempt = 1; ; attempt += 1) {
      try {
        request.onProgress?.(received, total);
        while (received < total) {
          const end = Math.min(received + piece, total);
          await this.sendBytes(session.id, request.body, received, end, total);
          received = end;
          request.onProgress?.(received, total);
        }
        return await this.commit(session.id, request, `${key}.done`);
      } catch (error) {
        if (attempt >= attempts || !isRetryable(error)) throw error;
        received = offset(await this.uploadSession(session.id));
      }
    }
  }

  private async sendBytes(
    uploadId: string,
    body: UploadBody,
    offset: number,
    end: number,
    total: number,
  ): Promise<void> {
    const headers = this.headers();
    headers['content-type'] = 'application/octet-stream';
    headers['content-range'] = `bytes ${offset}-${end - 1}/${total}`;
    const response = await fetch(this.url(`/api/v1/uploads/${uploadId}/content`), {
      method: 'PUT',
      headers,
      body: slice(body, offset, end),
    });
    if (!response.ok) throw await failure(response);
  }

  private commit(uploadId: string, request: UploadRequest, key: string): Promise<Asset> {
    return this.post<Asset>(
      `/api/v1/uploads/${uploadId}/complete`,
      {
        itemId: request.itemId,
        kind: request.kind,
        displayName: request.displayName,
        relativePath: request.relativePath,
        baseRevision: request.baseRevision,
      },
      key,
    );
  }

  private openUpload(libraryId: string, key: string): Promise<UploadSession> {
    return this.post<UploadSession>('/api/v1/uploads', { libraryId }, key);
  }

  private uploadSession(uploadId: string): Promise<UploadSession> {
    return this.getJson(`/api/v1/uploads/${uploadId}`);
  }

  private async putJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(this.url(path), {
      method: 'PUT',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  }

  private async putEmpty(path: string, body: unknown): Promise<void> {
    const response = await fetch(this.url(path), {
      method: 'PUT',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failure(response);
  }

  private async post<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T> {
    const headers = this.headers();
    headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const response = await fetch(this.url(path), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  }

  private async remove(path: string): Promise<void> {
    const response = await fetch(this.url(path), { method: 'DELETE', headers: this.headers() });
    if (!response.ok) throw await failure(response);
  }

  private async getJson<T>(
    path: string,
    redirect?: RequestInit['redirect'],
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(this.url(path), { headers: this.headers(), redirect, signal });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  }

  private url(path: string): URL {
    return new URL(path, this.baseUrl);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }
}

class DownloadChangedError extends Error {}

/**
 * Worth another attempt only when the refusal says nothing about the request
 * itself: a dropped connection, a server fault, or an offset that moved under
 * us. A stale revision or a rejected path fails the same way every time.
 */
function isRetryable(error: unknown): boolean {
  if (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
    return false;
  if (error instanceof RangeError) return false;
  if (!(error instanceof ContentError)) return true;
  if (error.status >= 500) return true;
  return error.status === 409 && error.problem?.type.endsWith('upload-gap') === true;
}

async function failure(response: Response): Promise<ContentError> {
  const problem = await response
    .json()
    .then((value) => value as Problem)
    .catch(() => null);
  return new ContentError(response.status, problem);
}

function totalBytes(response: Response): number | null {
  const range = response.headers.get('content-range');
  const total = range
    ? (/\/(\d+)$/.exec(range)?.[1] ?? null)
    : response.headers.get('content-length');
  if (total === null) return null;
  const parsed = Number(total);
  if (!/^\d+$/.test(total) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError('Invalid content size or length');
  }
  return parsed;
}

function sizeOf(body: UploadBody): number {
  return body instanceof Uint8Array ? body.byteLength : body.size;
}

async function* chunks(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (!body) {
    signal?.throwIfAborted();
    return;
  }
  const reader = body.getReader();
  let completed = false;
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        completed = true;
        return;
      }
      if (value) yield value;
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function concat(parts: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function slice(body: UploadBody, offset: number, end: number): UploadBody {
  return body instanceof Uint8Array ? body.subarray(offset, end) : body.slice(offset, end);
}

function validateBrowsePage(value: unknown): asserts value is LibraryBrowsePage {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const nullableString = (v: unknown) => v === null || typeof v === 'string';
  const fail = () => {
    throw new TypeError('Invalid library browse response');
  };
  const strings = (v: Record<string, unknown>, keys: string[]) =>
    keys.every((key) => typeof v[key] === 'string');
  const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (
    object(value) &&
    value.systemCounts !== undefined &&
    (!Array.isArray(value.systemCounts) ||
      value.systemCounts.some(
        (row: unknown) =>
          !object(row) ||
          typeof row.systemId !== 'string' ||
          !integer(row.count) ||
          row.count === 0,
      ))
  )
    fail();
  const item = (v: unknown): v is Record<string, unknown> =>
    object(v) &&
    strings(v, ['id', 'libraryId', 'systemIdentifier', 'title', 'createdAt', 'updatedAt']) &&
    integer(v.revision) &&
    nullableString(v.md5) &&
    nullableString(v.crc);
  const asset = (v: unknown): v is Record<string, unknown> =>
    object(v) &&
    strings(v, [
      'id',
      'itemId',
      'kind',
      'displayName',
      'relativePath',
      'sha256',
      'createdAt',
      'updatedAt',
    ]) &&
    integer(v.revision) &&
    integer(v.size) &&
    typeof v.shareable === 'boolean' &&
    nullableString(v.md5) &&
    nullableString(v.crc) &&
    (v.conflictOf === undefined || nullableString(v.conflictOf));
  const source = (v: unknown): v is Record<string, unknown> =>
    object(v) &&
    strings(v, ['id', 'rootId', 'name', 'kind', 'availability', 'medium', 'contentPath']) &&
    nullableString(v.libraryId) &&
    nullableString(v.systemId) &&
    integer(v.size) &&
    (v.title === undefined || (typeof v.title === 'string' && v.title.length <= 512)) &&
    (v.artworkAvailable === undefined || typeof v.artworkAvailable === 'boolean') &&
    v.contentPath === `/api/v1/sources/${encodeURIComponent(String(v.id))}/content`;

  if (
    !object(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    !nullableString(value.nextCursor) ||
    (typeof value.nextCursor === 'string' && value.nextCursor.length > 4096)
  )
    return fail();
  for (const entry of value.items) {
    if (
      !object(entry) ||
      typeof entry.entityType !== 'string' ||
      !['item', 'asset', 'source'].includes(entry.entityType) ||
      typeof entry.id !== 'string' ||
      typeof entry.name !== 'string' ||
      !nullableString(entry.libraryId) ||
      !nullableString(entry.systemId) ||
      typeof entry.canUpload !== 'boolean' ||
      typeof entry.canAdopt !== 'boolean'
    )
      return fail();
    for (const key of ['item', 'asset', 'source'])
      if (
        key === entry.entityType
          ? !object(entry[key]) || entry[key].id !== entry.id
          : entry[key] !== undefined
      )
        return fail();
    if (
      entry.entityType === 'item' &&
      (!item(entry.item) ||
        entry.item.libraryId !== entry.libraryId ||
        entry.item.systemIdentifier !== entry.systemId ||
        entry.item.title !== entry.name)
    )
      return fail();
    if (
      entry.entityType === 'asset' &&
      (!asset(entry.asset) ||
        !item(entry.parentItem) ||
        entry.parentItem.libraryId !== entry.libraryId ||
        entry.parentItem.systemIdentifier !== entry.systemId ||
        entry.asset.displayName !== entry.name ||
        (entry.canAdopt && !entry.asset.conflictOf))
    )
      return fail();
    if (
      entry.entityType === 'source' &&
      (!source(entry.source) ||
        entry.source.libraryId !== entry.libraryId ||
        entry.source.systemId !== entry.systemId ||
        (entry.source.title ?? entry.source.name) !== entry.name)
    )
      return fail();
    if (
      (entry.entityType === 'source' && (entry.canUpload || entry.canAdopt)) ||
      (entry.entityType !== 'asset' && entry.parentItem !== undefined) ||
      (entry.entityType !== 'item' && entry.previewAsset !== undefined) ||
      (entry.entityType === 'item' && entry.canAdopt)
    )
      return fail();
    if (
      entry.entityType === 'asset' &&
      (!object(entry.parentItem) ||
        (entry.asset as Record<string, unknown>).itemId !== entry.parentItem.id)
    )
      return fail();
    if (
      entry.previewAsset !== undefined &&
      (!asset(entry.previewAsset) ||
        entry.previewAsset.kind !== 'artwork' ||
        entry.previewAsset.itemId !== entry.id)
    )
      return fail();
  }
}

/** A flat portable asset basename, excluding runtime configuration and executable resources. */
export function isPlayerSystemFileName(name: string): boolean {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) &&
    !name.endsWith('.') &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) &&
    !/^(?:loader\.js|core\.wasm|plugin\.json|retroarch\.cfg)$/i.test(name)
  );
}

function validatePlayerId(id: string): void {
  if (
    typeof id !== 'string' ||
    id.length > 120 ||
    !/^(?:[a-z0-9][a-z0-9_-]{0,63}|[a-z0-9]+(?:\.[a-z0-9-]+)+)$/.test(id)
  )
    throw new Error('Invalid player profile identifier');
}
function validatePlayerProfile(p: WebPlayerDescriptor, id: string): void {
  validatePlayerId(id);
  if (
    !p ||
    p.id !== id ||
    p.profileVersion !== 1 ||
    !['emscripten-esm-v1', 'retroarch-emscripten-esm', 'dolphin-wasm-esm'].includes(p.runtime) ||
    p.filesystem !== 'memfs' ||
    (p.systemFilesDirectory !== undefined &&
      (typeof p.systemFilesDirectory !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(p.systemFilesDirectory) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(p.systemFilesDirectory))) ||
    (p.runtime === 'dolphin-wasm-esm'
      ? p.threaded !== true || p.saveCompletion !== 'none'
      : p.threaded !== false) ||
    !['none', 'command-reply-v1'].includes(p.saveCompletion) ||
    typeof p.name !== 'string' ||
    !p.name.length ||
    p.name.length > 80 ||
    typeof p.buildVersion !== 'string' ||
    !p.buildVersion.length ||
    p.buildVersion.length > 128 ||
    !Number.isSafeInteger(p.maxContentBytes) ||
    p.maxContentBytes <= 0 ||
    p.maxContentBytes > (p.runtime === 'dolphin-wasm-esm' ? 9 * 1024 ** 3 : 536870912)
  )
    throw new Error('Unsupported player profile');
  if (
    !Array.isArray(p.systems) ||
    !p.systems.length ||
    p.systems.length > 64 ||
    new Set(p.systems).size !== p.systems.length ||
    p.systems.some(
      (x) =>
        typeof x !== 'string' || x.length > 120 || !/^[A-Za-z0-9]+(?:\.[A-Za-z0-9_-]+)+$/.test(x),
    )
  )
    throw new Error('Invalid player systems');
  if (
    !Array.isArray(p.contentExtensions) ||
    !p.contentExtensions.length ||
    p.contentExtensions.length > 32 ||
    new Set(p.contentExtensions).size !== p.contentExtensions.length ||
    p.contentExtensions.some((x) => typeof x !== 'string' || !/^[a-z0-9]{1,16}$/.test(x))
  )
    throw new Error('Invalid player extensions');
  const base = `/play/plugins/${id}`;
  const resource = (r: PlayerCoreResource, path: string, cap: number) => {
    if (
      !r ||
      r.url !== path ||
      typeof r.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(r.sha256) ||
      !Number.isSafeInteger(r.sizeBytes) ||
      r.sizeBytes <= 0 ||
      r.sizeBytes > cap
    )
      throw new Error('Invalid player resource path, size, or hash');
  };
  resource(p.loader, `${base}/loader.js`, 8388608);
  resource(p.wasm, `${base}/core.wasm`, 67108864);
  if (!Array.isArray(p.assets) || p.assets.length > 16) throw new Error('Invalid player assets');
  const names = new Set<string>();
  let total = 0;
  for (const a of p.assets) {
    if (
      !a ||
      typeof a.name !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(a.name) ||
      a.name.endsWith('.') ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(a.name) ||
      /^(?:loader\.js|core\.wasm|plugin\.json)$/i.test(a.name) ||
      names.has(a.name.toLowerCase())
    )
      throw new Error('Invalid player asset name');
    names.add(a.name.toLowerCase());
    resource(a, `${base}/assets/${a.name}`, 33554432);
    total += a.sizeBytes;
  }
  if (total > 33554432) throw new Error('Player assets exceed total byte limit');
}
