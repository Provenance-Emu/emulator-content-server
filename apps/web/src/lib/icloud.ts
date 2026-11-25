import type { IcloudImport, IcloudPreview } from '@ecs/client';

/**
 * The sign-in token from a message event, or null. Only a message from one of Apple's own
 * addresses counts: any page can post a message to this window.
 */
export function signInToken(origin: string, data: unknown): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (
    !['apple.com', 'icloud.com'].some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  )
    return null;
  const token =
    data && typeof data === 'object' ? (data as { ckWebAuthToken?: unknown }).ckWebAuthToken : null;
  return typeof token === 'string' && token.length > 0 && token.length <= 8192 ? token : null;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a preview found, as one sentence. */
export function previewSummary(preview: IcloudPreview): string {
  if (!preview.saves) return 'No saves were found in iCloud.';
  return `${count(preview.saves, 'save')} for ${count(preview.games, 'game')} in iCloud. ${
    preview.gamesHere === preview.games
      ? 'Every one of those games is in your library.'
      : `${count(preview.gamesHere, 'game')} of those ${preview.gamesHere === 1 ? 'is' : 'are'} in your library.`
  }`;
}

/** How an import ended, as one sentence. */
export function importSummary(result: IcloudImport): string {
  if (result.state === 'running')
    return result.total
      ? `Copying saves: ${result.processed} of ${result.total}.`
      : 'Reading the list of saves from iCloud.';
  const copied = `${count(result.imported, 'save')} brought in`;
  const failed = result.failed
    ? ` ${count(result.failed, 'save')} could not be downloaded and will be tried next time.`
    : '';
  if (result.state === 'cancelled') return `Stopped. ${copied}.${failed}`;
  if (result.state === 'failed')
    return `${result.message ?? 'The import stopped.'} ${copied}.${failed}`;
  return `${result.imported ? `${copied}.` : 'Nothing new to bring in.'}${failed}`;
}
