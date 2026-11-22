const KINDS: Record<string, string> = {
  'questionable-match': 'Details may be wrong',
  'missing-front-artwork': 'Missing front cover',
  'missing-artwork': 'Missing front cover',
  'system-mismatch': 'System may be wrong',
};

/** What a cleanup finding is about, in the words the page uses. Unknown kinds read as a phrase. */
export function findingLabel(kind: string | undefined): string {
  if (!kind) return '';
  return KINDS[kind] ?? kind.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase());
}
