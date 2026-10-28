/** Artwork is an asset role, not a new provider capability or an identity assertion. */
export const ARTWORK_ROLES = [
  'front',
  'back',
  'disc',
  'manual',
  'title',
  'screenshot',
  'other',
] as const;
export type ArtworkRole = (typeof ARTWORK_ROLES)[number];
const roles: Record<string, ArtworkRole> = {
  front: 'front',
  cover: 'front',
  covers: 'front',
  boxart: 'front',
  boxarts: 'front',
  back: 'back',
  backs: 'back',
  backcover: 'back',
  backcovers: 'back',
  disc: 'disc',
  discs: 'disc',
  cd: 'disc',
  cdlabel: 'disc',
  cdlabels: 'disc',
  disclabel: 'disc',
  manual: 'manual',
  manuals: 'manual',
  title: 'title',
  titles: 'title',
  titlescreen: 'title',
  screenshot: 'screenshot',
  screenshots: 'screenshot',
  snap: 'screenshot',
  snaps: 'screenshot',
  other: 'other',
  misc: 'other',
};
const roleKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/^named[_ -]/, '')
    .replace(/[ _-]/g, '');
/** Only explicit directories/source tags or terminal labels are classified. Plain images remain front covers. */
export function classifyArtwork(
  name: string,
  sourceType?: string,
): { role: ArtworkRole; baseTitle: string; explicit: boolean } {
  const parts = name.replace(/\\/g, '/').split('/');
  let baseTitle = (parts.pop() ?? name).replace(/\.(?:png|jpe?g|webp|gif|avif|pdf)$/i, '');
  const suffix =
    /(?:\s*\[([^[\]]+)\]|\s*\(([^()]*)\)|[ ._-]+(back[ ._-]?cover|cd[ ._-]?label|disc[ ._-]?label|title[ ._-]?screen|front|cover|boxart|back|disc|manual|title|screenshot|snap|other))$/i.exec(
      baseTitle,
    );
  const suffixRole = suffix && roles[roleKey(suffix[1] ?? suffix[2] ?? suffix[3] ?? '')];
  if (suffixRole && suffix) baseTitle = baseTitle.slice(0, suffix.index).trim();
  const explicitRole =
    suffixRole ??
    roles[roleKey(sourceType ?? '')] ??
    parts.map((part) => roles[roleKey(part)]).findLast(Boolean);
  return {
    role: explicitRole ?? (/\.pdf$/i.test(name) ? 'other' : 'front'),
    baseTitle: baseTitle.normalize('NFC'),
    explicit: !!explicitRole,
  };
}
