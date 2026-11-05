export const skinOrigins = [
  'https://emuskins.com',
  'https://raw.githubusercontent.com',
  'https://deltastyles.com',
] as const;
export function safeExternalUrl(value: string): string {
  const u = new URL(value);
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    value.length > 2048 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw Error('Unsupported skin URL');
  if (
    ![
      'emuskins.com',
      'raw.githubusercontent.com',
      'deltastyles.com',
      'github.com',
      'drive.google.com',
    ].includes(u.hostname)
  )
    throw Error('Unsupported skin host');
  return u.href;
}
export function directSkinUrl(value: string) {
  const u = new URL(safeExternalUrl(value));
  if (!skinOrigins.some((o) => o === u.origin))
    throw Error('This provider requires downloading the file first.');
  if (
    u.hostname === 'raw.githubusercontent.com' &&
    !u.pathname.startsWith('/Provenance-Emu/skins/')
  )
    throw Error('Unsupported raw skin repository');
  if (u.hostname === 'emuskins.com' && u.pathname !== '/catalog.json')
    throw Error('Unsupported catalog path');
  if (u.hostname === 'deltastyles.com' && !u.pathname.startsWith('/files/skins/'))
    throw Error('Unsupported download path');
  return u.href;
}
export async function boundedFetch(
  value: string,
  limit: number,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const url = directSkinUrl(value),
    controller = new AbortController(),
    abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 20000);
  try {
    const r = await fetcher(url, {
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      mode: 'cors',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!r.ok || r.redirected || (r.url && r.url !== url))
      throw Error('This provider requires downloading the file first.');
    const length = r.headers.get('content-length');
    if (length && (!Number.isFinite(Number(length)) || Number(length) > limit))
      throw Error('Download byte limit exceeded');
    if (!r.body) throw Error('Empty skin response');
    const reader = r.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw Error('Download byte limit exceeded');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    controller.signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    return bytes;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
