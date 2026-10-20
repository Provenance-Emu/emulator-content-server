export type RangeParse =
  | { type: 'partial'; start: number; end: number }
  | { type: 'unsatisfiable' }
  | { type: 'invalid' };

export function strongEtag(value: string): string {
  return `"${value}"`;
}

export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((part) => {
    const value = part.trim().replace(/^W\//, '');
    return value === '*' || value === etag.replace(/^W\//, '');
  });
}

export function ifRangeMatches(header: string | undefined, etag: string): boolean {
  if (!header) return true;
  const value = header.trim();
  if (value.includes(',') || value.startsWith('W/') || etag.startsWith('W/') || value.includes(':'))
    return false;
  return value === etag;
}

export function parseSingleRange(header: string, size: number): RangeParse {
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith('bytes=')) return { type: 'invalid' };
  const spec = trimmed.slice(trimmed.indexOf('=') + 1).trim();
  if (spec.includes(',')) return { type: 'invalid' };
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match) return { type: 'invalid' };
  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  if (startRaw === '' && endRaw === '') return { type: 'invalid' };
  if (size === 0) return { type: 'unsatisfiable' };
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { type: 'invalid' };
    const length = Math.min(suffix, size);
    return { type: 'partial', start: size - length, end: size - 1 };
  }
  const start = Number(startRaw);
  if (!Number.isSafeInteger(start) || start < 0) return { type: 'invalid' };
  if (start >= size) return { type: 'unsatisfiable' };
  let end = size - 1;
  if (endRaw !== '') {
    end = Number(endRaw);
    if (!Number.isSafeInteger(end) || end < start) return { type: 'invalid' };
    if (end >= size) end = size - 1;
  }
  return { type: 'partial', start, end };
}

export function parseContentRange(
  header: string,
): { start: number; end: number; total: number | null } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const totalRaw = match[3] ?? '*';
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  const total = totalRaw === '*' ? null : Number(totalRaw);
  if (total !== null && (!Number.isSafeInteger(total) || end >= total)) return null;
  return { start, end, total };
}
