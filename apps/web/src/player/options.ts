import { isPlayerCoreOptions } from '@ecs/client';
export interface CoreOption {
  key: string;
  value: string;
  description: string;
  values?: string[];
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls in untrusted runtime/config text.
const controls = /[\x00-\x1f\x7f]/;
export function containsControls(text: string): boolean {
  return controls.test(text);
}
export function validOptionKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(key) &&
    !['__proto__', 'constructor', 'prototype'].includes(key)
  );
}
export function validOptionValue(value: unknown): value is string {
  // These values also enter a quoted RetroArch config; reject ambiguous encoding.
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !containsControls(value) &&
    !/["\\|]/.test(value)
  );
}
export function parseOptions(raw: string, key?: string, detail = key !== undefined): CoreOption[] {
  if (typeof raw !== 'string' || raw.length > 60000)
    throw new Error('Core option reply exceeds limit');
  const text = raw.replace(/[\r\n]+$/, '');
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length > 512 || (key !== undefined && lines.length !== 1))
    throw new Error('Invalid core option count');
  const seen = new Set<string>();
  return lines.map((line) => {
    const fields = line.split('\t');
    const [name, value, description, choices] = fields;
    if (
      fields.length !== (detail ? 4 : 3) ||
      !validOptionKey(name) ||
      !validOptionValue(value) ||
      typeof description !== 'string' ||
      description.length > 2048 ||
      containsControls(description) ||
      seen.has(name) ||
      (key !== undefined && name !== key)
    )
      throw new Error('Invalid core option reply');
    seen.add(name);
    const result: CoreOption = { key: name, value, description };
    if (detail) {
      const values = choices?.split('|') ?? [];
      if (
        !values.length ||
        values.length > 256 ||
        values.some((v) => !validOptionValue(v)) ||
        new Set(values).size !== values.length ||
        !values.includes(value)
      )
        throw new Error('Invalid core option values');
      result.values = values;
    }
    return result;
  });
}
export function coreOptionsConfig(options: Record<string, string>, defaults?: unknown): string {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length > 512
  )
    throw new Error('Invalid core options');
  if (defaults !== undefined && !isPlayerCoreOptions(defaults))
    throw new Error('Invalid default core options');
  options = { ...(defaults as Record<string, string> | undefined), ...options };
  if (Object.keys(options).length > 512) throw new Error('Core options exceed limit');
  let result = '';
  for (const [key, value] of Object.entries(options).sort(([a], [b]) => a.localeCompare(b))) {
    if (!validOptionKey(key) || !validOptionValue(value))
      throw new Error('Invalid core option preference');
    result += `${key} = "${value}"\n`;
  }
  if (result.length > 60000) throw new Error('Core option preferences exceed limit');
  return result;
}
