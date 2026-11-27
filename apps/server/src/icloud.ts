import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isLoopbackAddress } from '@ecs/auth';
import { saveImportKey } from '@ecs/database';
import { DomainError } from '@ecs/domain';
import { createStagingFile, removeStaging } from '@ecs/storage';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  appleAddress,
  type CloudKitEnvironment,
  CloudKitError,
  type CloudKitFetch,
  CloudKitSession,
  type CloudSave,
  parseCloudSave,
} from './cloudkit.js';
import type { ServerContext } from './context.js';
import { jsonObject, requiredString, requireOwner } from './http.js';
import {
  describedGame,
  describedSave,
  READER_ACCOUNTS,
  READER_FAILURES,
  READER_IDLE_SECONDS,
  READER_PAGE_LIMIT,
  type ReaderAccount,
  ReaderError,
  ReaderHub,
} from './icloud-reader.js';
import { peerAddress } from './local-access.js';

/** Reading saves from the owner's iCloud. Present only when the server was given an API token. */
export interface IcloudOptions {
  apiToken: string;
  container?: string;
  environment?: CloudKitEnvironment;
  /** Stand-ins for Apple, for tests. */
  fetch?: CloudKitFetch;
  download?: (url: string, signal: AbortSignal) => Promise<Response>;
  /** How long the reader's `work` call is held open. Only a test shortens it. */
  readerWaitMs?: number;
  /** A reader that has not called for this long is gone. Only a test shortens it. */
  readerSilentMs?: number;
}

/** Where saves are read from: Apple's web service, or the reader on the Mac beside the server. */
type Source = 'web' | 'mac';

export const ICLOUD_CONTAINER = 'iCloud.org.provenance-emu.provenance';
const SAVE_KEYS = [
  'gameID',
  'filename',
  'systemIdentifier',
  'coreIdentifier',
  'fileData',
  'fileSize',
  'lastModifiedDevice',
];
/** Stops a runaway listing; a household has far fewer. */
const MAX_SAVES = 50_000;
const MAX_SAVE_BYTES = 512 * 1024 * 1024;
/** A download that takes longer than this has stalled. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const OWNER_ONLY = 'Only the server owner can use iCloud saves';
const NO_READER =
  'Open Emulation Server on the Mac that runs this server, signed in to iCloud, to read saves from there';

interface Preview {
  checkedAt: string;
  source: Source;
  saves: number;
  bytes: number;
  games: number;
  gamesHere: number;
  ready: number;
  alreadyHere: number;
  unmatched: Array<{
    gameId: string;
    systemIdentifier: string | null;
    title: string | null;
    saves: number;
  }>;
}

interface ImportProgress {
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  source: Source;
  total: number;
  processed: number;
  imported: number;
  skipped: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
}

/** Places staged bytes as a save beside whatever the game already has. Supplied by `routes.ts`. */
export type StoreImportedSave = (input: {
  uploadId: string;
  itemId: string;
  displayName: string;
  relativePath: string;
  actorId: string;
}) => Promise<{ id: string }>;

export function registerIcloudRoutes(
  app: FastifyInstance,
  context: ServerContext,
  store: StoreImportedSave,
): void {
  const options = context.icloud;
  if (!options) {
    // Every operation in the contract exists on every server; without a token each says so.
    const absent = async () => {
      throw new DomainError('not-found', 404, 'iCloud saves are not set up on this server');
    };
    app.get('/api/v1/icloud', absent);
    app.post('/api/v1/icloud/sign-in', absent);
    app.put('/api/v1/icloud/session', absent);
    app.delete('/api/v1/icloud/session', absent);
    app.post('/api/v1/icloud/preview', absent);
    app.post('/api/v1/icloud/import', absent);
    app.post('/api/v1/icloud/import/cancel', absent);
    app.post('/api/v1/icloud/reader/attach', absent);
    app.get('/api/v1/icloud/reader/work', absent);
    app.put('/api/v1/icloud/reader/account', absent);
    app.post('/api/v1/icloud/reader/listing', absent);
    app.post('/api/v1/icloud/reader/listing/failed', absent);
    app.put('/api/v1/icloud/reader/saves/:requestId', absent);
    app.post('/api/v1/icloud/reader/saves/:requestId/failed', absent);
    return;
  }
  const { catalog } = context;
  const container = options.container ?? ICLOUD_CONTAINER;
  const origin = `icloud:${container}`;
  const session = new CloudKitSession({
    apiToken: options.apiToken,
    container,
    environment: options.environment ?? 'production',
    fetch:
      options.fetch ??
      ((url, init) => fetch(url, { ...init, redirect: 'error' }) as ReturnType<CloudKitFetch>),
  });
  const download =
    options.download ??
    ((url: string, signal: AbortSignal) => fetch(url, { redirect: 'error', signal }));
  const reader = new ReaderHub({
    waitMs: options.readerWaitMs ?? 25_000,
    silentMs: options.readerSilentMs ?? 60_000,
    listMs: 5 * 60_000,
    maxSaves: MAX_SAVES,
    maxSaveBytes: MAX_SAVE_BYTES,
  });
  /** The same proof local owner sign-in asks for: this run's key, which only this user can read. */
  const readerKey = () => (context.localTrust ? (context.localOwnerKey ?? null) : null);
  let preview: Preview | null = null;
  let progress: ImportProgress | null = null;
  let running: AbortController | null = null;
  /** Goes up on connect and disconnect, so a slow answer for an earlier sign-in is dropped. */
  let generation = 0;

  const status = () => ({
    connected: session.signedIn,
    container,
    ...(preview ? { preview } : {}),
    ...(progress ? { import: progress } : {}),
    reader: { offered: readerKey() !== null, state: reader.state, lastSeenAt: reader.lastSeenAt },
  });

  /** The source a request names, or the Mac when its reader can read right now. */
  function sourceFor(request: FastifyRequest): Source {
    const body = request.body;
    const asked =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).source
        : undefined;
    if (asked !== undefined && asked !== 'web' && asked !== 'mac')
      throw new DomainError('invalid-body', 400, 'source must be web or mac');
    const source = asked ?? (reader.state === 'ready' ? 'mac' : 'web');
    if (source === 'mac' && reader.state !== 'ready' && reader.state !== 'working')
      throw new DomainError('conflict', 409, NO_READER);
    return source;
  }
  const owner = (request: FastifyRequest) => requireOwner(request, OWNER_ONLY);

  /**
   * A call to Apple is never cut short: its answer carries the token the next call needs, and
   * losing it would end the sign-in. Stopping is noticed between calls.
   */
  async function listSaves(source: Source, signal?: AbortSignal): Promise<CloudSave[]> {
    if (source === 'mac') return reader.list(signal);
    const saves: CloudSave[] = [];
    for await (const record of session.records('SaveState', { desiredKeys: SAVE_KEYS })) {
      if (signal?.aborted) break;
      const save = parseCloudSave(record);
      if (save) saves.push(save);
      if (saves.length >= MAX_SAVES) break;
    }
    return saves;
  }

  /**
   * The game a save belongs to. First by the identifier the app filed it under, which is the
   * game file's MD5 for most games. The app does not hash every file whole (it skips a
   * cartridge header, reorders an N64 image, hashes a disc's data track), so when that finds
   * nothing the game is looked for by the file the app recorded for it: same system, same file
   * name, same size, and only when exactly one file here answers.
   */
  function locate(save: CloudSave): ReturnType<typeof catalog.gameForMd5> {
    const found = catalog.gameForMd5(save.gameId);
    if (found || !save.rom?.filename) return found;
    const systemIdentifier = save.rom.systemIdentifier ?? save.systemIdentifier;
    if (!systemIdentifier) return null;
    return catalog.gameForRomFile({
      systemIdentifier,
      filename: save.rom.filename,
      size: save.rom.size,
    });
  }

  function summarize(saves: CloudSave[], source: Source): Preview {
    const imported = catalog.importedSaveKeys(origin);
    const games = new Map<
      string,
      { here: boolean; systemIdentifier: string | null; title: string | null; saves: number }
    >();
    let ready = 0;
    let alreadyHere = 0;
    let bytes = 0;
    for (const save of saves) {
      bytes += save.size;
      let game = games.get(save.gameId);
      if (!game) {
        game = {
          here: locate(save) !== null,
          systemIdentifier: save.systemIdentifier,
          title: save.rom?.title ?? null,
          saves: 0,
        };
        games.set(save.gameId, game);
      }
      game.saves += 1;
      if (!game.here) continue;
      if (imported.has(saveImportKey(save.recordName, save.changeTag))) alreadyHere += 1;
      else ready += 1;
    }
    const unmatched = [...games]
      .filter(([, game]) => !game.here)
      .map(([gameId, game]) => ({
        gameId,
        systemIdentifier: game.systemIdentifier,
        title: game.title,
        saves: game.saves,
      }))
      .sort((a, b) => b.saves - a.saves || a.gameId.localeCompare(b.gameId));
    return {
      checkedAt: new Date().toISOString(),
      source,
      saves: saves.length,
      bytes,
      games: games.size,
      gamesHere: games.size - unmatched.length,
      ready,
      alreadyHere,
      unmatched: unmatched.slice(0, 50),
    };
  }

  /** The library a save's game is in, or null when the server does not have the game. */
  function libraryFor(save: CloudSave): string | null {
    const found = locate(save);
    if (!found) return null;
    if ('itemId' in found) return catalog.getItem(found.itemId)?.libraryId ?? null;
    const source = catalog.getSource(found.sourceId);
    return source?.systemId ? source.libraryId : null;
  }

  /**
   * The game a save belongs to, giving a scanned file a game entry when it has none. Called only
   * once the save's bytes are in hand, so a failed download leaves no empty game behind.
   */
  function gameFor(save: CloudSave, actorId: string): { id: string; libraryId: string } | null {
    const found = locate(save);
    if (!found) return null;
    if ('itemId' in found) return catalog.getItem(found.itemId);
    const source = catalog.getSource(found.sourceId);
    if (!source?.libraryId || !source.systemId) return null;
    return catalog.createItem({
      libraryId: source.libraryId,
      systemIdentifier: source.systemId,
      title: (source.title ?? source.displayName).slice(0, 256),
      md5: null,
      crc: null,
      actorId,
      sourceId: source.id,
    });
  }

  /** Downloads a save from Apple's address for it into `path`. Answers with how many bytes. */
  async function downloadSave(save: CloudSave, path: string, signal: AbortSignal): Promise<number> {
    if (!save.downloadUrl) throw new Error('No download');
    const response = await download(save.downloadUrl, signal);
    if (!response.ok || !response.body) throw new Error('Download failed');
    let received = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        done(received > MAX_SAVE_BYTES ? new Error('Save is too large') : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), counted, createWriteStream(path), {
      signal,
    });
    return received;
  }

  async function copy(
    save: CloudSave,
    actorId: string,
    signal: AbortSignal,
    source: Source,
  ): Promise<boolean> {
    if (source === 'web' && (!save.downloadUrl || !appleAddress(save.downloadUrl)))
      throw new Error('No download');
    const libraryId = libraryFor(save);
    if (!libraryId) return false;
    const upload = catalog.createUpload({ userId: actorId, guestGrantId: null, libraryId });
    const limited = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
    try {
      const path = await createStagingFile(context.dataDir, upload.id);
      const received =
        source === 'mac'
          ? await reader.fetch(save.recordName, path, limited)
          : await downloadSave(save, path, limited);
      if (received === 0) throw new Error('Save is empty');
      const game = gameFor(save, actorId);
      if (!game || game.libraryId !== libraryId) return false;
      catalog.setUploadReceived(upload.id, received);
      const asset = await store({
        uploadId: upload.id,
        itemId: game.id,
        displayName: `${save.filename} · iCloud`.slice(0, 240),
        relativePath: savePath(save),
        actorId,
      });
      catalog.recordSaveImport({
        origin,
        recordName: save.recordName,
        changeTag: save.changeTag,
        assetId: asset.id,
        device: save.device,
        modifiedAt: save.modifiedAt,
      });
      return true;
    } finally {
      catalog.abortUpload(upload.id, actorId);
      await removeStaging(context.dataDir, upload.id);
    }
  }

  async function run(actorId: string, state: ImportProgress, signal: AbortSignal): Promise<void> {
    const asked = generation;
    const source = state.source;
    try {
      const saves = await listSaves(source, signal);
      const imported = catalog.importedSaveKeys(origin);
      state.total = saves.length;
      for (const save of saves) {
        if (signal.aborted) break;
        if (imported.has(saveImportKey(save.recordName, save.changeTag))) state.skipped += 1;
        else {
          try {
            if (await copy(save, actorId, signal, source)) state.imported += 1;
            else state.skipped += 1;
          } catch (error) {
            if (signal.aborted) break;
            // A full library stops the run: every later save would fail the same way.
            if (error instanceof DomainError && error.code === 'quota-exceeded') throw error;
            // Without the reader every later save would wait and fail the same way.
            if (error instanceof ReaderError && error.failure === 'gone') throw error;
            state.failed += 1;
          }
        }
        state.processed += 1;
      }
      state.state = signal.aborted ? 'cancelled' : 'completed';
      if (!signal.aborted && asked === generation) preview = summarize(saves, source);
    } catch (error) {
      state.state = signal.aborted ? 'cancelled' : 'failed';
      if (!signal.aborted) state.message = plain(error);
    } finally {
      state.finishedAt = new Date().toISOString();
      if (running?.signal === signal) running = null;
    }
  }

  app.get('/api/v1/icloud', async (request) => {
    owner(request);
    return status();
  });

  app.post('/api/v1/icloud/sign-in', async (request) => {
    owner(request);
    return { signInUrl: await apple(() => session.signInUrl()) };
  });

  app.put('/api/v1/icloud/session', async (request) => {
    owner(request);
    const token = jsonObject(request.body).webAuthToken;
    if (typeof token !== 'string' || !token || token.length > 8192)
      throw new DomainError('invalid-body', 400, 'webAuthToken is required');
    if (running) throw new DomainError('conflict', 409, 'An import is running');
    generation += 1;
    preview = null;
    session.useWebAuthToken(token);
    try {
      await apple(() => session.verify());
    } catch (error) {
      session.useWebAuthToken(null);
      throw error;
    }
    return status();
  });

  app.delete('/api/v1/icloud/session', async (request, reply) => {
    owner(request);
    running?.abort();
    generation += 1;
    session.useWebAuthToken(null);
    preview = null;
    return reply.status(204).send();
  });

  app.post('/api/v1/icloud/preview', async (request) => {
    owner(request);
    if (running) throw new DomainError('conflict', 409, 'An import is running');
    const source = sourceFor(request);
    const asked = generation;
    const found = summarize(await apple(() => listSaves(source)), source);
    if (asked !== generation) throw new DomainError('conflict', 409, 'Sign in to iCloud again');
    preview = found;
    return found;
  });

  app.post('/api/v1/icloud/import', async (request, reply) => {
    const actor = owner(request);
    if (running) throw new DomainError('conflict', 409, 'An import is already running');
    const source = sourceFor(request);
    if (source === 'web' && !session.signedIn)
      throw new DomainError('conflict', 409, 'Sign in to iCloud first');
    running = new AbortController();
    progress = {
      state: 'running',
      source,
      total: 0,
      processed: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: null,
    };
    void run(actor.userId, progress, running.signal);
    return reply.status(202).send(progress);
  });

  app.post('/api/v1/icloud/import/cancel', async (request, reply) => {
    owner(request);
    running?.abort();
    return reply.status(204).send();
  });

  // The reader on the Mac beside the server. Nothing below takes a session: the ticket is the
  // only pass, it is checked before anything else, and it opens nothing outside these routes.
  const READER = '/api/v1/icloud/reader';

  function ticket(request: FastifyRequest): void {
    if (!isLoopbackAddress(peerAddress(request)))
      throw new DomainError(
        'forbidden',
        403,
        'The iCloud reader only works on the computer that runs the server',
      );
    const candidate = /^Bearer\s+(\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (!candidate || !reader.admits(candidate))
      throw new DomainError('unauthorized', 401, 'The reader ticket is missing or has run out');
  }

  app.post(`${READER}/attach`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const key = readerKey();
    if (!key)
      throw new DomainError(
        'local-sign-in-unavailable',
        409,
        'A reader on this computer is not available on this server',
      );
    if (!isLoopbackAddress(peerAddress(request)))
      throw new DomainError(
        'forbidden',
        403,
        'The iCloud reader only works on the computer that runs the server',
      );
    // The same budget as local owner sign-in: both guess at the same key.
    if (!context.limiter.allow(`local:${request.ip}`))
      throw new DomainError('rate-limited', 429, 'Too many attempts');
    const candidate = requiredString(jsonObject(request.body), 'key');
    if (!catalog.ownerUserId())
      throw new DomainError('not-bootstrapped', 409, 'Create the owner account first');
    if (!key.matches(candidate)) {
      catalog.recordLocalSignInFailure();
      throw new DomainError('unauthorized', 401, "That is not this server's current local key");
    }
    return reply.send({ ticket: reader.attach(), idleSeconds: READER_IDLE_SECONDS });
  });

  app.get(`${READER}/work`, async (request, reply) => {
    ticket(request);
    reply.header('cache-control', 'no-store');
    return reader.next();
  });

  app.put(`${READER}/account`, async (request, reply) => {
    ticket(request);
    const state = jsonObject(request.body).state;
    if (!READER_ACCOUNTS.includes(state as ReaderAccount))
      throw new DomainError('invalid-body', 400, 'state is not one this server knows');
    reader.setAccount(state as ReaderAccount);
    return reply.status(204).send();
  });

  app.post(`${READER}/listing`, async (request, reply) => {
    ticket(request);
    const body = jsonObject(request.body);
    if (!Array.isArray(body.saves) || body.saves.length > READER_PAGE_LIMIT)
      throw new DomainError('invalid-body', 400, 'saves must be a list of at most 500');
    if (typeof body.done !== 'boolean')
      throw new DomainError('invalid-body', 400, 'done is required');
    const saves: CloudSave[] = [];
    for (const raw of body.saves) {
      const save = describedSave(raw, MAX_SAVE_BYTES);
      if (!save) throw new DomainError('invalid-body', 400, 'A save is described wrongly');
      saves.push(save);
    }
    const games: Array<[string, NonNullable<CloudSave['rom']>]> = [];
    if (body.games !== undefined) {
      if (!Array.isArray(body.games) || body.games.length > READER_PAGE_LIMIT)
        throw new DomainError('invalid-body', 400, 'games must be a list of at most 500');
      for (const raw of body.games) {
        const game = describedGame(raw);
        if (!game) throw new DomainError('invalid-body', 400, 'A game is described wrongly');
        games.push(game);
      }
    }
    if (!reader.addListing(saves, body.done, games))
      throw new DomainError('conflict', 409, 'The server did not ask for a listing');
    return reply.status(204).send();
  });

  app.post(`${READER}/listing/failed`, async (request, reply) => {
    ticket(request);
    reader.failListing(failure(request));
    return reply.status(204).send();
  });

  app.put<{ Params: { requestId: string } }>(
    `${READER}/saves/:requestId`,
    async (request, reply) => {
      ticket(request);
      const body = request.body as NodeJS.ReadableStream | undefined;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function')
        throw new DomainError('invalid-body', 400, 'Send the save as application/octet-stream');
      let taken: boolean;
      try {
        taken = await reader.receive(request.params.requestId, body);
      } catch (error) {
        if (error instanceof ReaderError && error.failure === 'too-large')
          throw new DomainError('quota-exceeded', 413, 'The save is larger than this server takes');
        throw new DomainError('invalid-body', 400, 'The save could not be taken');
      }
      if (!taken)
        throw new DomainError('not-found', 404, 'The server is not waiting for this save');
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { requestId: string } }>(
    `${READER}/saves/:requestId/failed`,
    async (request, reply) => {
      ticket(request);
      failure(request);
      if (!reader.failFetch(request.params.requestId))
        throw new DomainError('not-found', 404, 'The server is not waiting for this save');
      return reply.status(204).send();
    },
  );

  app.addHook('onClose', async () => {
    running?.abort();
    reader.abandon();
  });
}

/** Checks the reason a reader gives for a failure is one of the fixed list. */
function failure(request: FastifyRequest): string {
  const reason = jsonObject(request.body).reason;
  if (typeof reason !== 'string' || !READER_FAILURES.includes(reason))
    throw new DomainError('invalid-body', 400, 'reason is not one this server knows');
  return reason;
}

/** Turns a failure from Apple into an answer the owner can act on. Never quotes an address. */
async function apple<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ReaderError) {
      if (error.failure === 'busy')
        throw new DomainError('conflict', 409, 'The Mac is already looking for saves');
      if (error.failure === 'too-many')
        throw new DomainError(
          'bad-gateway',
          502,
          'The Mac listed more saves than this server takes',
        );
      throw new DomainError('unavailable', 503, plain(error));
    }
    if (!(error instanceof CloudKitError)) throw error;
    if (error.failure === 'sign-in-required')
      throw new DomainError('conflict', 409, 'Sign in to iCloud again');
    if (error.failure === 'refused') throw new DomainError('forbidden', 403, plain(error));
    if (error.failure === 'busy')
      throw new DomainError('unavailable', 503, 'iCloud is busy. Try again in a few minutes.');
    throw new DomainError('bad-gateway', 502, 'iCloud did not answer as expected');
  }
}

function plain(error: unknown): string {
  if (error instanceof ReaderError) {
    if (error.failure === 'gone')
      return 'The Mac stopped answering. Check Emulation Server is open there, then try again.';
    if (error.failure === 'too-many') return 'The Mac listed more saves than this server takes.';
    if (error.failure === 'not-allowed')
      return "iCloud did not let this copy of Emulation Server read Provenance's saves. That is a fault in this build, not in your account; try a newer build.";
    if (error.failure === 'account')
      return 'The Mac that runs this server could not use its iCloud account. Check it is signed in to iCloud, then try again.';
    if (error.failure === 'busy') return 'The Mac is already looking for saves. Try again shortly.';
    return 'The Mac could not read iCloud just now. Try again in a few minutes.';
  }
  if (error instanceof CloudKitError) {
    if (error.failure === 'sign-in-required') return 'The iCloud sign-in ran out. Sign in again.';
    if (error.failure === 'refused')
      return 'iCloud would not let this account be read from the web. If Advanced Data Protection is on, turn on "Access iCloud Data on the Web" in iCloud settings and try again.';
    if (error.failure === 'busy') return 'iCloud is busy. Try again in a few minutes.';
    return 'iCloud did not answer as expected.';
  }
  if (error instanceof DomainError && error.code === 'quota-exceeded')
    return 'The library is full, so the rest were not copied.';
  return 'The import stopped unexpectedly.';
}

/** Where an imported save sits among a game's files. Only safe characters survive. */
function savePath(save: CloudSave): string {
  const clean = (value: string) =>
    value
      .replace(/[^A-Za-z0-9._ -]/g, '_')
      .replace(/^[. ]+/, '_')
      .slice(0, 120) || '_';
  return `icloud/${clean(save.coreIdentifier ?? 'provenance')}/${clean(save.filename)}`;
}
