import type { ControllerLayout, LayoutRepresentation } from '../layout.js';
export const skinLimits = {
  archive: 32 * 1024 * 1024,
  entries: 256,
  expanded: 64 * 1024 * 1024,
  asset: 16 * 1024 * 1024,
  info: 512 * 1024,
  ratio: 200,
  assets: 16,
  pixels: 8_000_000,
  installed: 20,
  library: 256 * 1024 * 1024,
} as const;
export type Orientation = 'portrait' | 'landscape';
export interface SkinAsset {
  id: string;
  name: string;
  mediaType: 'image/png' | 'application/pdf';
  blob: Blob;
}
export interface SkinVariant {
  key: string;
  device: string;
  display: string;
  orientation: Orientation;
  representation: LayoutRepresentation;
  issues: string[];
  live: boolean;
}
export interface SkinPackage {
  id: string;
  name: string;
  author: string;
  system: string;
  variants: SkinVariant[];
  assets: SkinAsset[];
  original: Blob;
  bytes: number;
  created: number;
}
export interface SkinPreference {
  basis: string;
  choices: Partial<Record<Orientation, string>>;
  overrides: Partial<Record<Orientation, LayoutRepresentation>>;
}
export interface SkinLayoutPort {
  remember(scope: 'core' | 'game'): Promise<void>;
  clear(scope: 'core' | 'game'): Promise<void>;
}
export interface SkinSelection {
  selected: Partial<Record<Orientation, string>>;
  layout: ControllerLayout;
  issues: string[];
  live: boolean;
}
export function skinSystem(value: string): string {
  const s = value.toLowerCase().split('.').at(-1) ?? '';
  return (
    (
      {
        gb: 'gbc',
        gameboy: 'gbc',
        gameboycolor: 'gbc',
        megadrive: 'genesis',
        ds: 'nds',
        nintendo64: 'n64',
        supernintendo: 'snes',
      } as Record<string, string>
    )[s] ?? s
  );
}
