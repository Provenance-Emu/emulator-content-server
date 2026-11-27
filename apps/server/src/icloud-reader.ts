/**
 * The server's side of the iCloud reader that runs on the Mac beside it.
 *
 * The reader is a separate signed program that reads the owner's iCloud with Apple's framework,
 * for accounts Apple's web service refuses. It calls the server; the server never starts it and
 * never opens a file it names. Everything here is held in memory and ends with the process.
 * See docs/superpowers/specs/2026-11-26-native-icloud-reader-design.md.
 */
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hashToken, issueToken, tokenHashesEqual } from '@ecs/auth';
import type { CloudRom, CloudSave } from './cloudkit.js';

export type ReaderAccount = 'available' | 'signedOut' | 'restricted' | 'unknown';
export type ReaderState =
  | 'absent'
  | 'ready'
  | 'signedOut'
  | 'restricted'
  | 'unavailable'
  | 'working';
export type ReaderWork =
  | { work: 'none' | 'list' | 'stop' }
  | { work: 'fetch'; saves: Array<{ requestId: string; recordName: string }> };

export const READER_FAILURES = [
  'missing',
  'noFile',
  'account',
  'notAllowed',
  'busy',
  'network',
  'unexpected',
];
export const READER_ACCOUNTS: ReaderAccount[] = ['available', 'signedOut', 'restricted', 'unknown'];
export const READER_IDLE_SECONDS = 600;
const PAGE_LIMIT = 500;

/** Why the reader could not do what was asked. `gone` means it stopped calling. */
export class ReaderError extends Error {
  constructor(
    readonly failure:
      | 'gone'
      | 'stopped'
      | 'refused'
      | 'too-many'
      | 'busy'
      | 'too-large'
      | 'account'
      | 'not-allowed',
  ) {
    super(`The iCloud reader: ${failure}`);
    this.name = 'ReaderError';
  }
}

interface Listing {
  sent: boolean;
  saves: CloudSave[];
  games: Map<string, CloudRom>;
  resolve(saves: CloudSave[]): void;
  reject(error: Error): void;
}

interface Wanted {
  recordName: string;
  path: string;
  signal: AbortSignal;
  sent: boolean;
  receiving: boolean;
  /** Fires when this request ends for any reason, so a write under way stops with it. */
  ended: AbortController;
  resolve(bytes: number): void;
  reject(error: Error): void;
}

export class ReaderHub {
  private ticket: string | null = null;
  private lastSeen = 0;
  private account: ReaderAccount = 'unknown';
  private listing: Listing | null = null;
  private readonly wanted = new Map<string, Wanted>();
  private stop = false;
  private wake: (() => void) | null = null;
  private described = new Map<string, CloudRom>();

  constructor(
    private readonly limits: {
      /** How long `work` is held open with nothing to do. */
      waitMs: number;
      /** A reader that has not called for this long is gone. */
      silentMs: number;
      /** The longest a listing may take. */
      listMs: number;
      maxSaves: number;
      maxSaveBytes: number;
    },
  ) {}

  /** Issues the one ticket, replacing any earlier reader. Only the hash is kept. */
  attach(): string {
    const issued = issueToken();
    this.abandon(new ReaderError('gone'));
    this.ticket = issued.hash;
    this.stop = false;
    this.account = 'unknown';
    this.lastSeen = Date.now();
    return issued.token;
  }

  /** True for the current ticket while it has not sat idle too long. Counts as a sign of life. */
  admits(candidate: string): boolean {
    if (!this.ticket || !tokenHashesEqual(hashToken(candidate), this.ticket)) return false;
    if (Date.now() - this.lastSeen > READER_IDLE_SECONDS * 1000) {
      this.ticket = null;
      return false;
    }
    this.lastSeen = Date.now();
    return true;
  }

  get state(): ReaderState {
    if (!this.ticket || Date.now() - this.lastSeen > this.limits.silentMs) return 'absent';
    if (this.account === 'signedOut' || this.account === 'restricted') return this.account;
    if (this.account === 'unknown') return 'unavailable';
    return this.listing || this.wanted.size > 0 ? 'working' : 'ready';
  }

  get lastSeenAt(): string | null {
    return this.ticket ? new Date(this.lastSeen).toISOString() : null;
  }

  setAccount(account: ReaderAccount): void {
    this.account = account;
  }

  /** What the reader should do next. Waits a while when there is nothing. */
  async next(): Promise<ReaderWork> {
    const now = this.pending();
    if (now) return now;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, this.limits.waitMs);
      const wake = () => done();
      const self = this;
      function done() {
        clearTimeout(timer);
        if (self.wake === wake) self.wake = null;
        resolve();
      }
      // Only one reader waits at a time; a second call lets the first go.
      this.wake?.();
      this.wake = wake;
    });
    return this.pending() ?? { work: 'none' };
  }

  private pending(): ReaderWork | null {
    if (this.stop) {
      this.stop = false;
      return { work: 'stop' };
    }
    if (this.listing && !this.listing.sent) {
      this.listing.sent = true;
      return { work: 'list' };
    }
    for (const [requestId, wanted] of this.wanted) {
      if (wanted.sent) continue;
      wanted.sent = true;
      return { work: 'fetch', saves: [{ requestId, recordName: wanted.recordName }] };
    }
    return null;
  }

  /** Asks the reader for a description of every save. */
  list(signal?: AbortSignal): Promise<CloudSave[]> {
    if (this.listing) return Promise.reject(new ReaderError('busy'));
    // A reader that keeps calling but never finishes must not hold a request open for ever.
    const limited = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.limits.listMs),
    ]);
    return this.watched(limited, (resolve, reject) => {
      this.listing = { sent: false, saves: [], games: new Map(), resolve, reject };
      return () => {
        this.listing = null;
      };
    });
  }

  /** Takes one page of the listing. False when no listing was asked for. */
  addListing(saves: CloudSave[], done: boolean, games: Array<[string, CloudRom]> = []): boolean {
    const listing = this.listing;
    if (!listing?.sent) return false;
    listing.saves.push(...saves);
    for (const [gameId, rom] of games)
      if (listing.games.size < this.limits.maxSaves) listing.games.set(gameId.toUpperCase(), rom);
    if (listing.saves.length > this.limits.maxSaves) listing.reject(new ReaderError('too-many'));
    else if (done) {
      // A record named twice is taken once, so it cannot be copied in twice.
      this.described = listing.games;
      const once = new Map(listing.saves.map((save) => [save.recordName, save]));
      listing.resolve(
        [...once.values()].map((save) => {
          const rom = listing.games.get(save.gameId.toUpperCase());
          return rom ? { ...save, rom } : save;
        }),
      );
    }
    return true;
  }

  /** The reader could not list. `reason` is one of `READER_FAILURES`. */
  /** What the last finished listing said about the owner's games, by the app's identifier. */
  get games(): ReadonlyMap<string, CloudRom> {
    return this.described;
  }

  failListing(reason: string): void {
    const failure =
      reason === 'notAllowed' ? 'not-allowed' : reason === 'account' ? 'account' : 'refused';
    this.listing?.reject(new ReaderError(failure));
  }

  /** Asks the reader for one save's bytes, written to `path`. Answers with how many arrived. */
  fetch(recordName: string, path: string, signal: AbortSignal): Promise<number> {
    const requestId = issueToken().token.slice(0, 22);
    const ended = new AbortController();
    return this.watched(signal, (resolve, reject) => {
      this.wanted.set(requestId, {
        recordName,
        path,
        signal,
        sent: false,
        receiving: false,
        ended,
        resolve,
        reject,
      });
      return () => {
        this.wanted.delete(requestId);
        ended.abort();
      };
    });
  }

  /**
   * Writes an uploaded save to the place its request named. False when nothing is waiting for
   * `requestId`, which is how a save the server did not ask for is refused.
   */
  async receive(requestId: string, body: NodeJS.ReadableStream): Promise<boolean> {
    const wanted = this.wanted.get(requestId);
    if (!wanted?.sent || wanted.receiving) return false;
    wanted.receiving = true;
    let received = 0;
    const max = this.limits.maxSaveBytes;
    const counted = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        received += chunk.length;
        // Bytes arriving are a sign of life, however long the save takes.
        this.lastSeen = Date.now();
        done(received > max ? new ReaderError('too-large') : null, chunk);
      },
    });
    // Opened here, not lazily, so a request that has already ended cannot leave a file behind.
    if (wanted.ended.signal.aborted) return false;
    const file = createWriteStream(wanted.path, { flags: 'r+' });
    try {
      await pipeline(body, counted, file, { signal: wanted.ended.signal });
    } catch (error) {
      wanted.reject(error instanceof Error ? error : new Error('Upload failed'));
      throw error;
    }
    // Resolving ends the request, which fires `ended`; the write is finished by then.
    wanted.resolve(received);
    return true;
  }

  failFetch(requestId: string): boolean {
    const wanted = this.wanted.get(requestId);
    if (!wanted?.sent || wanted.receiving) return false;
    wanted.reject(new ReaderError('refused'));
    return true;
  }

  /** Ends everything in flight, for shutdown or a replaced reader. */
  abandon(error: Error = new ReaderError('stopped')): void {
    this.listing?.reject(error);
    for (const wanted of [...this.wanted.values()]) wanted.reject(error);
    this.wake?.();
  }

  /**
   * One request to the reader. It ends when the reader answers, when `signal` fires, or when the
   * reader has stopped calling. `begin` registers the request and returns how to remove it.
   */
  private watched<T>(
    signal: AbortSignal | undefined,
    begin: (resolve: (value: T) => void, reject: (error: Error) => void) => () => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let remove = () => {};
      const finish = () => {
        clearInterval(watch);
        signal?.removeEventListener('abort', aborted);
        remove();
      };
      const aborted = () => {
        finish();
        // The reader may be part-way through; tell it to drop what it holds.
        this.stop = true;
        this.wake?.();
        reject(new ReaderError('stopped'));
      };
      const watch = setInterval(
        () => {
          if (Date.now() - this.lastSeen <= this.limits.silentMs) return;
          finish();
          reject(new ReaderError('gone'));
        },
        Math.max(10, Math.min(2000, this.limits.silentMs / 4)),
      );
      watch.unref();
      if (signal?.aborted) return aborted();
      signal?.addEventListener('abort', aborted, { once: true });
      remove = begin(
        (value) => {
          finish();
          resolve(value);
        },
        (error) => {
          finish();
          reject(error);
        },
      );
      this.wake?.();
    });
  }
}

/** Checks one save description from the reader. Null when it is not usable. */
export function describedSave(raw: unknown, maxSaveBytes: number): CloudSave | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const required = (key: string, max: number) => {
    const found = value[key];
    return typeof found === 'string' && found.length > 0 && found.length <= max ? found : null;
  };
  const optional = (key: string, max: number) => {
    const found = value[key];
    if (found === null || found === undefined) return null;
    return typeof found === 'string' && found.length <= max ? found : undefined;
  };
  const recordName = required('recordName', 512);
  const gameId = required('gameId', 128);
  const filename = required('filename', 512);
  const changeTag = typeof value.changeTag === 'string' ? value.changeTag : null;
  const systemIdentifier = optional('systemIdentifier', 256);
  const coreIdentifier = optional('coreIdentifier', 256);
  const device = optional('device', 128);
  const modified = optional('modifiedAt', 64);
  const size = value.size;
  if (!recordName || !gameId || !filename || changeTag === null || changeTag.length > 128)
    return null;
  if (systemIdentifier === undefined || coreIdentifier === undefined || device === undefined)
    return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > maxSaveBytes)
    return null;
  if (modified === undefined || (modified !== null && Number.isNaN(Date.parse(modified))))
    return null;
  return {
    recordName,
    changeTag,
    gameId,
    filename,
    systemIdentifier,
    coreIdentifier,
    size,
    downloadUrl: null,
    device,
    modifiedAt: modified === null ? null : new Date(Date.parse(modified)).toISOString(),
  };
}

export const READER_PAGE_LIMIT = PAGE_LIMIT;

/** Checks one game description from the reader. Null when it is not usable. */
export function describedGame(raw: unknown): [string, CloudRom] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const text = (key: string, max: number) => {
    const found = value[key];
    if (found === null || found === undefined || found === '') return null;
    return typeof found === 'string' && found.length <= max ? found : undefined;
  };
  const gameId = text('gameId', 128);
  const systemIdentifier = text('systemIdentifier', 256);
  const filename = text('filename', 512);
  const title = text('title', 512);
  const size = value.size;
  if (!gameId || systemIdentifier === undefined || filename === undefined || title === undefined)
    return null;
  if (
    size !== null &&
    size !== undefined &&
    (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
  )
    return null;
  const count = (key: string) => {
    const found = value[key];
    if (found === null || found === undefined) return null;
    return typeof found === 'number' && Number.isSafeInteger(found) && found >= 0
      ? found
      : undefined;
  };
  const playCount = count('playCount');
  const secondsPlayed = count('secondsPlayed');
  const played = text('lastPlayedAt', 64);
  if (playCount === undefined || secondsPlayed === undefined || played === undefined) return null;
  if (played !== null && Number.isNaN(Date.parse(played))) return null;
  // A date from the future would sit at the top of the recently played list for ever.
  const lastPlayedAt =
    played === null ? null : new Date(Math.min(Date.parse(played), Date.now())).toISOString();
  // A name is compared with file names here; one that tries to be a path is not a name.
  if (filename && /[\\/\0]/.test(filename)) return null;
  return [
    gameId,
    {
      systemIdentifier,
      filename,
      size: typeof size === 'number' ? size : null,
      title,
      lastPlayedAt,
      playCount,
      secondsPlayed,
    },
  ];
}
