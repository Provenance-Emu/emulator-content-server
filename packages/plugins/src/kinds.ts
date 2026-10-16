/**
 * The asset kinds the content contract accepts. Kept here so a feed or a
 * connector can be loaded without the OpenAPI package, and checked against
 * that contract by the plugin host.
 */
export const ASSET_KINDS = [
  'rom',
  'battery_save',
  'save_state',
  'screenshot',
  'artwork',
  'bios',
  'system_file',
] as const;

export type AssetKindName = (typeof ASSET_KINDS)[number];

const SAVE_KINDS: ReadonlySet<string> = new Set(['battery_save', 'save_state']);

export function isAssetKind(value: string): value is AssetKindName {
  return (ASSET_KINDS as readonly string[]).includes(value);
}

/** A save is the one kind a concurrent write must not discard. */
export function isSaveKind(kind: string): boolean {
  return SAVE_KINDS.has(kind);
}

export interface KindRule {
  suffix: string;
  kind: AssetKindName;
}

/**
 * Longest matching suffix wins, so `.state.sav` can be a battery save while
 * `.sav` is too. Anything unmatched is a ROM, which keeps strict concurrency.
 */
export function classify(relativePath: string, rules: readonly KindRule[]): AssetKindName {
  const lower = relativePath.toLowerCase();
  let match: KindRule | undefined;
  for (const rule of rules) {
    if (!lower.endsWith(rule.suffix.toLowerCase())) continue;
    if (!match || rule.suffix.length > match.suffix.length) match = rule;
  }
  return match?.kind ?? 'rom';
}
