/** Neutral evidence. Hashes identify an explicit byte representation, never a container by accident. */
export interface RomHash {
  algorithm: 'md5' | 'sha1' | 'crc32';
  value: string;
  size: number;
  representation: string;
  verified: boolean;
}
export interface RomIdentifier {
  type: 'serial' | 'set';
  value: string;
  systemId: string | null;
  verified: boolean;
}
export interface RomFacts {
  version: 1;
  pluginIds: string[];
  hashes: RomHash[];
  identifiers: RomIdentifier[];
  names: string[];
  warnings: string[];
}
function invalid(): never {
  throw new Error('Invalid ROM identification facts');
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key))) invalid();
  return row;
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  );
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}
/** Validate and copy worker/plugin output before merging it into trusted request state. */
export function validateRomFacts(value: unknown): RomFacts {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    invalid();
  }
  if (!encoded || Buffer.byteLength(encoded) > 65536) invalid();
  const root = record(value, [
    'version',
    'pluginIds',
    'hashes',
    'identifiers',
    'names',
    'warnings',
  ]);
  if (root.version !== 1) invalid();
  const pluginIds = array(root.pluginIds, 16).map((id) => {
    if (!text(id, 120) || !/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(id)) invalid();
    return id;
  });
  if (new Set(pluginIds).size !== pluginIds.length) invalid();
  const hashes = array(root.hashes, 16).map((raw) => {
    const hash = record(raw, ['algorithm', 'value', 'size', 'representation', 'verified']);
    const length =
      hash.algorithm === 'md5'
        ? 32
        : hash.algorithm === 'sha1'
          ? 40
          : hash.algorithm === 'crc32'
            ? 8
            : 0;
    if (
      !length ||
      typeof hash.value !== 'string' ||
      hash.value.length !== length ||
      !/^[0-9a-f]+$/i.test(hash.value) ||
      !Number.isSafeInteger(hash.size) ||
      Number(hash.size) < 0 ||
      !text(hash.representation, 512) ||
      typeof hash.verified !== 'boolean'
    )
      invalid();
    return {
      algorithm: hash.algorithm as RomHash['algorithm'],
      value: hash.value.toLowerCase(),
      size: Number(hash.size),
      representation: hash.representation,
      verified: hash.verified,
    };
  });
  const identifiers = array(root.identifiers, 32).map((raw) => {
    const id = record(raw, ['type', 'value', 'systemId', 'verified']);
    if (
      !['serial', 'set'].includes(String(id.type)) ||
      !text(id.value, 160) ||
      !(
        id.systemId === null ||
        (text(id.systemId, 120) && /^[A-Za-z0-9]+(?:\.[A-Za-z0-9_-]+)+$/.test(id.systemId))
      ) ||
      typeof id.verified !== 'boolean'
    )
      invalid();
    return {
      type: id.type as RomIdentifier['type'],
      value: id.value,
      systemId: id.systemId as string | null,
      verified: id.verified,
    };
  });
  const names = array(root.names, 32).map((name) => {
    if (!text(name, 512)) invalid();
    return name;
  });
  const warnings = array(root.warnings, 32).map((warning) => {
    if (!text(warning, 256) || !/^[a-z0-9][a-z0-9:._-]*$/.test(warning)) invalid();
    return warning;
  });
  return { version: 1, pluginIds, hashes, identifiers, names, warnings };
}
