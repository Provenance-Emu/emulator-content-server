import type {
  Asset,
  Capabilities,
  ChangeList,
  ContentRoot,
  ContentRootDraft,
  ContentRootList,
  ItemList,
  LibraryList,
  Manifest,
  Problem,
  SessionResponse,
  UploadSession,
} from './generated.js';

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
}

export class ContentClient {
  constructor(
    private readonly baseUrl: string,
    private token?: string,
  ) {}

  setToken(token: string | undefined): void {
    this.token = token;
  }

  capabilities(): Promise<Capabilities> {
    return this.getJson('/api/v1/capabilities');
  }

  /** Unauthenticated liveness, which is what a menu-bar indicator polls. */
  health(): Promise<{ ok: boolean }> {
    return this.getJson('/health');
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
  roots(): Promise<ContentRootList> {
    return this.getJson('/api/v1/roots');
  }

  addRoot(draft: ContentRootDraft): Promise<ContentRoot> {
    return this.post<ContentRoot>('/api/v1/roots', draft);
  }

  removeRoot(rootId: string): Promise<void> {
    return this.remove(`/api/v1/roots/${rootId}`);
  }

  manifest(itemId: string): Promise<Manifest> {
    return this.getJson(`/api/v1/items/${itemId}/manifest`);
  }

  asset(assetId: string): Promise<Asset> {
    return this.getJson(`/api/v1/files/${assetId}`);
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
    const plan = planResume(query.localBytes ?? 0, null);
    const headers = this.headers();
    if (plan.range) {
      headers.range = plan.range;
      if (query.etag) headers['if-range'] = query.etag;
    }
    const response = await fetch(this.url(`/api/v1/files/${assetId}/content`), { headers });
    if (response.status >= 400 && response.status !== 416) throw await failure(response);
    const instruction = interpretDownload(response.status, plan.offset);
    const carriesContent = instruction === 'append' || instruction === 'restart';
    if (!carriesContent) await response.body?.cancel();
    return {
      instruction,
      offset: instruction === 'append' ? plan.offset : 0,
      etag: response.headers.get('etag'),
      totalBytes: totalBytes(response),
      body: carriesContent ? response.body : null,
    };
  }

  /**
   * Sends the bytes and commits the asset, resuming from the offset the server
   * admits to holding. A retry re-reads that offset instead of assuming the
   * failed attempt wrote nothing, and the completion key is replayed so a lost
   * response cannot commit twice.
   */
  async upload(request: UploadRequest, attempts = 3): Promise<Asset> {
    const key = request.idempotencyKey ?? crypto.randomUUID();
    const session = request.uploadId
      ? await this.uploadSession(request.uploadId)
      : await this.openUpload(request.libraryId, `${key}.open`);
    const total = sizeOf(request.body);
    let received = session.received;
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (received < total) await this.sendBytes(session.id, request.body, received, total);
        return await this.commit(session.id, request, `${key}.done`);
      } catch (error) {
        if (attempt >= attempts || !isRetryable(error)) throw error;
        received = (await this.uploadSession(session.id)).received;
      }
    }
  }

  private async sendBytes(
    uploadId: string,
    body: UploadBody,
    offset: number,
    total: number,
  ): Promise<void> {
    const headers = this.headers();
    headers['content-type'] = 'application/octet-stream';
    headers['content-range'] = `bytes ${offset}-${total - 1}/${total}`;
    const response = await fetch(this.url(`/api/v1/uploads/${uploadId}/content`), {
      method: 'PUT',
      headers,
      body: slice(body, offset),
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

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(this.url(path), { headers: this.headers() });
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

/**
 * Worth another attempt only when the refusal says nothing about the request
 * itself: a dropped connection, a server fault, or an offset that moved under
 * us. A stale revision or a rejected path fails the same way every time.
 */
function isRetryable(error: unknown): boolean {
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
  return total === null ? null : Number(total);
}

function sizeOf(body: UploadBody): number {
  return body instanceof Uint8Array ? body.byteLength : body.size;
}

function slice(body: UploadBody, offset: number): UploadBody {
  return body instanceof Uint8Array ? body.subarray(offset) : body.slice(offset);
}
