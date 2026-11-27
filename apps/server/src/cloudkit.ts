/**
 * Read-only access to one person's private CloudKit database through Apple's web service.
 *
 * There is no write call here, on purpose: the apps depend on this data.
 *
 * Apple accepts the API token and the person's web auth token only as query parameters, so the
 * addresses built here are secret. They are never put in an error, and nothing here logs.
 */

export type CloudKitEnvironment = 'production' | 'development';

export interface CloudKitResponse {
  status: number;
  json(): Promise<unknown>;
}

/** The network call, passed in so a test can stand in for Apple. */
export type CloudKitFetch = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<CloudKitResponse>;

export type CloudKitFailure =
  /** No sign-in, or Apple ended it. */
  | 'sign-in-required'
  /** Apple will not let this account's private data be read from the web. */
  | 'refused'
  /** Apple asked for a pause. */
  | 'busy'
  | 'unexpected';

export class CloudKitError extends Error {
  readonly failure: CloudKitFailure;
  readonly signInUrl?: string;
  readonly retryAfter?: number;
  constructor(
    failure: CloudKitFailure,
    message: string,
    extra: { signInUrl?: string; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = 'CloudKitError';
    this.failure = failure;
    if (extra.signInUrl) this.signInUrl = extra.signInUrl;
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter;
  }
}

export interface CloudKitRecord {
  recordName: string;
  recordType: string;
  changeTag: string;
  fields: Record<string, { value: unknown; type?: string }>;
  modifiedAt: string | null;
}

export interface CloudSave {
  recordName: string;
  changeTag: string;
  /** What the app filed the save under: the game's MD5 in current versions. */
  gameId: string;
  filename: string;
  systemIdentifier: string | null;
  coreIdentifier: string | null;
  size: number;
  downloadUrl: string | null;
  device: string | null;
  modifiedAt: string | null;
  /** What the app records about the game's file, when a reader supplied it. */
  rom?: CloudRom;
}

/** A game as the app's own ROM record describes it. */
export interface CloudRom {
  systemIdentifier: string | null;
  filename: string | null;
  size: number | null;
  title: string | null;
  /** When the game was last played in the app, and the counts it kept. */
  lastPlayedAt?: string | null;
  playCount?: number | null;
  secondsPlayed?: number | null;
}

const HOST = 'https://api.apple-cloudkit.com';
const PAGE = 200;

export class CloudKitSession {
  private webAuthToken: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly base: string;

  constructor(
    private readonly options: {
      apiToken: string;
      container: string;
      environment: CloudKitEnvironment;
      fetch: CloudKitFetch;
      /** Only a test changes this. */
      host?: string;
    },
  ) {
    if (!/^iCloud\.[A-Za-z0-9.-]{1,200}$/.test(options.container))
      throw new Error('Not an iCloud container identifier');
    this.base = `${options.host ?? HOST}/database/1/${options.container}/${options.environment}`;
  }

  get signedIn(): boolean {
    return this.webAuthToken !== null;
  }

  /** Takes the token Apple's sign-in window handed over. Pass null to forget it. */
  useWebAuthToken(token: string | null): void {
    this.webAuthToken = token;
  }

  /** The address of Apple's sign-in page for this container. */
  async signInUrl(signal?: AbortSignal): Promise<string> {
    try {
      await this.call('GET', 'public/users/caller', undefined, signal, false);
    } catch (error) {
      if (error instanceof CloudKitError && error.failure === 'sign-in-required' && error.signInUrl)
        return error.signInUrl;
      throw error;
    }
    throw new CloudKitError('unexpected', 'Apple did not ask for a sign-in');
  }

  /** Confirms the held sign-in works. */
  async verify(signal?: AbortSignal): Promise<void> {
    await this.call('GET', 'public/users/caller', undefined, signal, true);
  }

  /**
   * Every record of one type in the default zone of the private database, or in `zone`. A caller
   * that wants to stop should stop reading between pages and not pass a signal: a call cut short
   * loses the replacement token in its answer.
   */
  async *records(
    recordType: string,
    options: { zone?: string; desiredKeys?: string[]; signal?: AbortSignal } = {},
  ): AsyncGenerator<CloudKitRecord> {
    let marker: string | undefined;
    do {
      const body = {
        query: { recordType },
        resultsLimit: PAGE,
        ...(options.zone ? { zoneID: { zoneName: options.zone } } : {}),
        ...(options.desiredKeys ? { desiredKeys: options.desiredKeys } : {}),
        ...(marker ? { continuationMarker: marker } : {}),
      };
      const page = object(
        await this.call('POST', 'private/records/query', body, options.signal, true),
      );
      for (const raw of Array.isArray(page.records) ? page.records : []) {
        const record = parseRecord(raw);
        if (record) yield record;
      }
      marker = typeof page.continuationMarker === 'string' ? page.continuationMarker : undefined;
    } while (marker);
  }

  /** One call at a time: each answer replaces the token the next call must use. */
  private call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    asPerson: boolean,
  ): Promise<unknown> {
    const run = this.queue.then(() => this.send(method, path, body, signal, asPerson));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    asPerson: boolean,
  ): Promise<unknown> {
    if (asPerson && !this.webAuthToken)
      throw new CloudKitError('sign-in-required', 'Sign in to iCloud first');
    const query = new URLSearchParams({ ckAPIToken: this.options.apiToken });
    if (asPerson && this.webAuthToken) query.set('ckWebAuthToken', this.webAuthToken);
    let response: CloudKitResponse;
    let answer: Record<string, unknown>;
    try {
      response = await this.options.fetch(`${this.base}/${path}?${query}`, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
      answer = object(await response.json());
    } catch (error) {
      if (signal?.aborted) throw error;
      // The cause may quote the address, which holds both tokens. It is dropped.
      throw new CloudKitError('unexpected', 'Could not reach iCloud');
    }
    if (asPerson && typeof answer.ckWebAuthToken === 'string' && answer.ckWebAuthToken)
      this.webAuthToken = answer.ckWebAuthToken;
    const code = typeof answer.serverErrorCode === 'string' ? answer.serverErrorCode : null;
    if (!code && response.status >= 200 && response.status < 300) return answer;
    if (code === 'AUTHENTICATION_REQUIRED' || code === 'AUTHENTICATION_FAILED') {
      if (asPerson) this.webAuthToken = null;
      const signInUrl = typeof answer.redirectURL === 'string' ? answer.redirectURL : undefined;
      throw new CloudKitError('sign-in-required', 'Sign in to iCloud again', {
        ...(signInUrl && appleAddress(signInUrl) ? { signInUrl } : {}),
      });
    }
    if (code === 'ACCESS_DENIED')
      throw new CloudKitError('refused', 'iCloud would not let this account be read from the web');
    if (code === 'THROTTLED' || code === 'TRY_AGAIN_LATER' || response.status === 503) {
      const wait = Number(answer.retryAfter);
      throw new CloudKitError('busy', 'iCloud asked to wait', {
        ...(Number.isFinite(wait) && wait > 0 ? { retryAfter: wait } : {}),
      });
    }
    throw new CloudKitError('unexpected', `iCloud answered ${code ?? response.status}`);
  }
}

/** True for an https address under one of Apple's own domains. */
export function appleAddress(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  return ['apple.com', 'icloud.com', 'icloud-content.com', 'apple-cloudkit.com'].some(
    (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
  );
}

/** Reads a Provenance `SaveState` record. Null when it has no game or no file name. */
export function parseCloudSave(record: CloudKitRecord): CloudSave | null {
  const gameId = text(record, 'gameID');
  const filename = text(record, 'filename');
  if (!gameId || !filename) return null;
  const asset = object(record.fields.fileData?.value);
  const address = typeof asset.downloadURL === 'string' ? asset.downloadURL : null;
  // Apple leaves a placeholder for the name the download should be served under.
  const downloadUrl = address?.replace(/\$\{f\}/, encodeURIComponent(filename)) ?? null;
  const size = Number(asset.size ?? record.fields.fileSize?.value ?? 0);
  return {
    recordName: record.recordName,
    changeTag: record.changeTag,
    gameId,
    filename,
    systemIdentifier: text(record, 'systemIdentifier'),
    coreIdentifier: text(record, 'coreIdentifier'),
    size: Number.isFinite(size) && size > 0 ? size : 0,
    downloadUrl: downloadUrl && appleAddress(downloadUrl) ? downloadUrl : null,
    device: text(record, 'lastModifiedDevice'),
    modifiedAt: record.modifiedAt,
  };
}

function parseRecord(raw: unknown): CloudKitRecord | null {
  const value = object(raw);
  if (typeof value.recordName !== 'string' || typeof value.recordType !== 'string') return null;
  // A record Apple could not return carries an error code in place of its fields.
  if (typeof value.serverErrorCode === 'string') return null;
  const stamp = Number(object(value.modified).timestamp);
  return {
    recordName: value.recordName,
    recordType: value.recordType,
    changeTag: typeof value.recordChangeTag === 'string' ? value.recordChangeTag : '',
    fields: object(value.fields) as CloudKitRecord['fields'],
    modifiedAt: Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toISOString() : null,
  };
}

function text(record: CloudKitRecord, field: string): string | null {
  const value = record.fields[field]?.value;
  return typeof value === 'string' && value ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
