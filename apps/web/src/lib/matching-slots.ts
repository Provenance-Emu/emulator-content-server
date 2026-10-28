type Match = { kind: string; artworkRole?: string; metadata: Record<string, unknown> };
export const artworkRoles = [
  ['front', 'Front cover'],
  ['back', 'Back cover'],
  ['disc', 'Disc label'],
  ['manual', 'Manual'],
  ['title', 'Title screen'],
  ['screenshot', 'Screenshot'],
  ['other', 'Other artwork'],
] as const;
export function roleOf(match: Match): string {
  const role = match.artworkRole ?? match.metadata.artworkRole;
  return typeof role === 'string' ? role : 'front';
}
export function matchSlot(match: Match): string {
  return match.kind === 'artwork' ? `artwork:${roleOf(match)}` : match.kind;
}
export function matchLabel(match: Match): string {
  return match.kind === 'artwork'
    ? (artworkRoles.find(([role]) => role === roleOf(match))?.[1].toLowerCase() ?? 'artwork')
    : match.kind;
}
