import type { IcloudImport, IcloudPreview, IcloudStatus } from '@ecs/client';

/** Whether a message came from one of Apple's own addresses. Any page can post to this window. */
function fromApple(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  // Apple's sign-in ends on a page under apple-cloudkit.com, which is what sends the message.
  return ['apple.com', 'icloud.com', 'apple-cloudkit.com'].some(
    (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
  );
}

/**
 * The sign-in token from a message event, or null. Apple's page posts its whole answer and
 * names the token `ckSession`; the address-callback form of the same sign-in calls it
 * `ckWebAuthToken`, so both are read.
 */
export function signInToken(origin: string, data: unknown): string | null {
  if (!fromApple(origin) || !data || typeof data !== 'object') return null;
  const answer = data as { ckSession?: unknown; ckWebAuthToken?: unknown };
  const token = answer.ckSession ?? answer.ckWebAuthToken;
  return typeof token === 'string' && token.length > 0 && token.length <= 8192 ? token : null;
}

/** What to tell the owner when Apple's sign-in window reports that it failed, or null. */
export function signInFailure(origin: string, data: unknown): string | null {
  if (!fromApple(origin) || !data || typeof data !== 'object') return null;
  const reason = (data as { errorMessage?: unknown }).errorMessage;
  if (typeof reason !== 'string') return null;
  if (reason === 'accessError')
    return 'This Apple Account does not allow its iCloud data to be read on the web. On an iPhone, iPad or Mac, open Settings, your name, iCloud, turn on Access iCloud Data on the Web, then try again.';
  if (reason === 'window closed')
    return 'The sign-in window was closed before signing in finished.';
  // Apple gives no reason here. The one cause seen so far is Advanced Data Protection, which
  // Apple's page reports this way rather than with its own message.
  return 'Apple could not finish signing in. If Advanced Data Protection is on for this Apple Account, Apple does not let its iCloud data be read this way. Otherwise close the sign-in window and try again.';
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a preview found, as one sentence. */
export function previewSummary(preview: IcloudPreview): string {
  const plays =
    (preview.playedGames
      ? ` Play history for ${count(preview.playedGames, 'game')} here can be brought in.`
      : '') +
    (preview.detailsToBring
      ? ` Details for ${count(preview.detailsToBring, 'game')} can be filled in${
          preview.coversToBring
            ? `, with ${count(preview.coversToBring, 'cover')} you chose in Provenance`
            : ''
        }. Nothing you set here is replaced.`
      : '');
  if (!preview.saves) return `No saves were found in iCloud.${plays}`;
  return `${count(preview.saves, 'save')} for ${count(preview.games, 'game')} in iCloud. ${
    preview.gamesHere === preview.games
      ? 'Every one of those games is in your library.'
      : `${count(preview.gamesHere, 'game')} of those ${preview.gamesHere === 1 ? 'is' : 'are'} in your library.`
  }${plays}`;
}

/** How an import ended, as one sentence. */
export function importSummary(result: IcloudImport): string {
  if (result.state === 'running')
    return result.total
      ? `Copying saves: ${result.processed} of ${result.total}.`
      : 'Reading the list of saves from iCloud.';
  const copied = `${count(result.imported, 'save')} brought in`;
  const failed =
    (result.failed
      ? ` ${count(result.failed, 'save')} could not be downloaded and will be tried next time.`
      : '') +
    (result.playsUpdated
      ? ` Play history for ${count(result.playsUpdated, 'game')} brought in.`
      : '') +
    (result.detailsUpdated
      ? ` Details filled in for ${count(result.detailsUpdated, 'game')}.`
      : '') +
    (result.coversUpdated ? ` ${count(result.coversUpdated, 'cover')} brought in.` : '');
  if (result.state === 'cancelled') return `Stopped. ${copied}.${failed}`;
  if (result.state === 'failed')
    return `${result.message ?? 'The import stopped.'} ${copied}.${failed}`;
  return `${result.imported ? `${copied}.` : 'Nothing new to bring in.'}${failed}`;
}

/** True when the Mac that runs the server can read iCloud itself, so no Apple sign-in is needed. */
export function macReads(reader: IcloudStatus['reader']): boolean {
  return reader?.state === 'ready' || reader?.state === 'working';
}

/** What to say about the Mac that runs the server, or null when this server cannot have a reader. */
export function readerNote(reader: IcloudStatus['reader']): string | null {
  if (!reader?.offered) return null;
  switch (reader.state) {
    case 'ready':
    case 'working':
      return 'The Mac that runs this server is signed in to iCloud, so saves are read there. No Apple sign-in is needed.';
    case 'signedOut':
      return 'The Mac that runs this server is not signed in to iCloud. Sign in there with the Apple account your devices use.';
    case 'restricted':
      return 'iCloud is switched off for Emulation Server on the Mac that runs this server. Turn it on in System Settings, your name, iCloud.';
    case 'unavailable':
      return 'The Mac that runs this server could not check iCloud just now.';
    default:
      return 'If this server runs on a Mac, open Emulation Server there while logged in to read iCloud without signing in here.';
  }
}
