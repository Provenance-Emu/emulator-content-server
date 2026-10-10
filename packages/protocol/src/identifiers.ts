import { ASSET_KINDS, type AssetKind } from './constants.js';

const SYSTEM_IDENTIFIER = /^[A-Za-z0-9]+(?:\.[A-Za-z0-9_-]+)+$/;
const USERNAME = /^[A-Za-z0-9._-]{3,32}$/;

export function validateSystemIdentifier(value: string): string | null {
  if (!SYSTEM_IDENTIFIER.test(value) || value.length > 120) {
    return 'System identifier must be a dotted name such as com.provenance.nes';
  }
  return null;
}

export function validateUsername(value: string): string | null {
  if (!USERNAME.test(value))
    return 'Username must be 3-32 letters, numbers, dots, underscores, or hyphens';
  return null;
}

export function validatePassword(value: string): string | null {
  if (value.length < 10 || value.length > 200) return 'Password must be 10-200 characters';
  return null;
}

export function validateAssetKind(value: string): AssetKind | null {
  return ASSET_KINDS.find((kind) => kind === value) ?? null;
}

export function assertSafeRelativePath(input: string): string {
  if (input.length === 0 || input.length > 1024 || input.includes('\0')) {
    throw new Error('Relative path is empty or too long');
  }
  const normalized = input.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('Relative path must not be absolute');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error('Relative path contains an empty, current, or parent segment');
  }
  return parts.join('/');
}
