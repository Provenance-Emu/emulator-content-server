import { PluginError } from '../errors.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export const WORKFLOW_LIMITS = Object.freeze({
  manifest: 64 * 1024,
  schema: 256 * 1024,
  envelope: 1024 * 1024,
  checkpoint: 64 * 1024,
  depth: 32,
});
const secretKeys = new Set([
  'apikey',
  'password',
  'authorization',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'bearertoken',
  'secret',
  'token',
]);

export function invalid(message = 'Invalid workflow contract'): never {
  throw new PluginError('invalid-workflow', message);
}

export function jsonValue(
  value: unknown,
  limit = WORKFLOW_LIMITS.envelope,
  rejectSecrets = false,
): JsonValue {
  const ancestors = new Set<object>();
  let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > WORKFLOW_LIMITS.depth)
      invalid('Workflow value exceeds structural limits');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null || ancestors.has(item))
      invalid('Workflow values must be JSON');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      invalid('Workflow values must be plain JSON');
    ancestors.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key))
        invalid('Unsafe workflow property');
      if (Array.isArray(item) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
        invalid('Workflow arrays cannot have named properties');
      if (rejectSecrets && secretKeys.has(key.toLowerCase().replaceAll(/[-_]/g, '')))
        invalid('Credentials do not belong in workflow payloads');
      const property = Object.getOwnPropertyDescriptor(item, key);
      if (!property || !('value' in property) || !property.enumerable)
        invalid('Workflow values must be plain JSON');
      visit(property.value, depth + 1);
    }
    if (Array.isArray(item) && Object.keys(item).length !== item.length)
      invalid('Workflow arrays must be dense JSON');
    ancestors.delete(item);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > limit)
    invalid('Workflow value exceeds byte limit');
  return value as JsonValue;
}

export function object(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('Expected workflow object');
  const record = value as Record<string, unknown>;
  if (allowed && Object.keys(record).some((key) => !allowed.includes(key)))
    invalid('Unknown workflow property');
  return record;
}

export function text(value: unknown, max = 200): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code);
    })
  )
    invalid('Invalid workflow text');
  return value;
}

export function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum)
    invalid('Invalid workflow integer');
  return Number(value);
}

export function list(value: unknown, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid('Invalid workflow list');
  return value;
}

export function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalid('Duplicate workflow identifier');
}
