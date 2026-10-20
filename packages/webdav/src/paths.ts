import { DomainError } from '@ecs/domain';

export function parseDavPath(url: string): string[] {
  const path = url.split('?')[0] ?? '';
  if (path !== '/dav' && !path.startsWith('/dav/'))
    throw new DomainError('invalid-body', 400, 'Invalid DAV path');
  const suffix = path.slice(4);
  if (suffix === '' || suffix === '/') return [];
  const parts = suffix.slice(1).replace(/\/$/, '').split('/');
  try {
    return parts.map((part) => {
      const value = decodeURIComponent(part).normalize('NFC');
      if (
        !value ||
        value === '.' ||
        value === '..' ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: reject XML-invalid or unsafe path characters
        /[/\\:\u0000-\u001f\u007f]/.test(value) ||
        /%[a-f0-9]{2}/i.test(value)
      )
        throw new Error('Unsafe path');
      return value;
    });
  } catch {
    throw new DomainError('invalid-body', 400, 'Invalid DAV path');
  }
}
export function davHref(segments: string[], collection: boolean): string {
  return `/dav/${segments.map(encodeURIComponent).join('/')}${collection && segments.length ? '/' : ''}`;
}
