import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
import { jsonObject, requireOwner } from './http.js';

/** Reading saves from the owner's iCloud. Present only when the server was given an API token. */
export interface IcloudOptions {
  apiToken: string;
  container?: string;
  environment?: CloudKitEnvironment;
  /** Stand-ins for Apple, for tests. */
  fetch?: CloudKitFetch;
  download?: (url: string, signal: AbortSignal) => Promise<Response>;
}

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

interface Preview {
  checkedAt: string;
  saves: number;
  bytes: number;
  games: number;
  gamesHere: number;
  ready: number;
  alreadyHere: number;
  unmatched: Array<{ gameId: string; systemIdentifier: string | null; saves: number }>;
}

interface ImportProgress {
  state: 'running' | 'completed' | 'failed' | 'cancelled';
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
  });
  const owner = (request: FastifyRequest) => requireOwner(request, OWNER_ONLY);

  /**
   * A call to Apple is never cut short: its answer carries the token the next call needs, and
   * losing it would end the sign-in. Stopping is noticed between calls.
   */
  async function listSaves(signal?: AbortSignal): Promise<CloudSave[]> {
    const saves: CloudSave[] = [];
    for await (const record of session.records('SaveState', { desiredKeys: SAVE_KEYS })) {
      if (signal?.aborted) break;
      const save = parseCloudSave(record);
      if (save) saves.push(save);
      if (saves.length >= MAX_SAVES) break;
    }
    return saves;
  }

  function summarize(saves: CloudSave[]): Preview {
    const imported = catalog.importedSaveKeys(origin);
    const games = new Map<
      string,
      { here: boolean; systemIdentifier: string | null; saves: number }
    >();
    let ready = 0;
    let alreadyHere = 0;
    let bytes = 0;
    for (const save of saves) {
      bytes += save.size;
      let game = games.get(save.gameId);
      if (!game) {
        game = {
          here: catalog.gameForMd5(save.gameId) !== null,
          systemIdentifier: save.systemIdentifier,
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
        saves: game.saves,
      }))
      .sort((a, b) => b.saves - a.saves || a.gameId.localeCompare(b.gameId));
    return {
      checkedAt: new Date().toISOString(),
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
    const found = catalog.gameForMd5(save.gameId);
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
    const found = catalog.gameForMd5(save.gameId);
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

  async function copy(save: CloudSave, actorId: string, signal: AbortSignal): Promise<boolean> {
    if (!save.downloadUrl || !appleAddress(save.downloadUrl)) throw new Error('No download');
    const libraryId = libraryFor(save);
    if (!libraryId) return false;
    const upload = catalog.createUpload({ userId: actorId, guestGrantId: null, libraryId });
    const limited = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
    try {
      const path = await createStagingFile(context.dataDir, upload.id);
      const response = await download(save.downloadUrl, limited);
      if (!response.ok || !response.body) throw new Error('Download failed');
      let received = 0;
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          done(received > MAX_SAVE_BYTES ? new Error('Save is too large') : null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body as never), counted, createWriteStream(path), {
        signal: limited,
      });
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
    try {
      const saves = await listSaves(signal);
      const imported = catalog.importedSaveKeys(origin);
      state.total = saves.length;
      for (const save of saves) {
        if (signal.aborted) break;
        if (imported.has(saveImportKey(save.recordName, save.changeTag))) state.skipped += 1;
        else {
          try {
            if (await copy(save, actorId, signal)) state.imported += 1;
            else state.skipped += 1;
          } catch (error) {
            if (signal.aborted) break;
            // A full library stops the run: every later save would fail the same way.
            if (error instanceof DomainError && error.code === 'quota-exceeded') throw error;
            state.failed += 1;
          }
        }
        state.processed += 1;
      }
      state.state = signal.aborted ? 'cancelled' : 'completed';
      if (!signal.aborted && asked === generation) preview = summarize(saves);
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
    const asked = generation;
    const found = summarize(await apple(() => listSaves()));
    if (asked !== generation) throw new DomainError('conflict', 409, 'Sign in to iCloud again');
    preview = found;
    return found;
  });

  app.post('/api/v1/icloud/import', async (request, reply) => {
    const actor = owner(request);
    if (running) throw new DomainError('conflict', 409, 'An import is already running');
    if (!session.signedIn) throw new DomainError('conflict', 409, 'Sign in to iCloud first');
    running = new AbortController();
    progress = {
      state: 'running',
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

  app.addHook('onClose', async () => {
    running?.abort();
  });
}

/** Turns a failure from Apple into an answer the owner can act on. Never quotes an address. */
async function apple<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
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
