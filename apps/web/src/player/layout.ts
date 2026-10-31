import { actions, type PadAction } from './input-model.js';
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ReferenceSize {
  width: number;
  height: number;
}
export type LayoutAction = PadAction | 'leftStick' | 'rightStick';
export interface LayoutControl {
  id: string;
  action: LayoutAction;
  frame: Rect;
  hitInsets?: { top: number; right: number; bottom: number; left: number };
  opacity: number;
  visual:
    | { kind: 'shape'; shape: 'circle' | 'rect'; label: string }
    | { kind: 'image'; assetId: string };
}
export interface LayoutRepresentation {
  reference: ReferenceSize;
  placement: 'overlay' | 'underlay';
  screens: { id: string; frame: Rect; inputFrame?: Rect }[];
  artwork?: { assetId: string; frame: Rect }[];
  controls: LayoutControl[];
}
export interface ControllerLayout {
  version: 1;
  id: string;
  name: string;
  assets: { id: string; mediaType: 'image/png' | 'image/svg+xml' | 'application/pdf' }[];
  representations: { portrait: LayoutRepresentation; landscape: LayoutRepresentation };
}
export interface LayoutFit {
  scale: number;
  x: number;
  y: number;
}
export function fitLayout(reference: ReferenceSize, width: number, height: number): LayoutFit {
  const scale = Math.max(0, Math.min(width / reference.width, height / reference.height));
  return {
    scale,
    x: (width - reference.width * scale) / 2,
    y: (height - reference.height * scale) / 2,
  };
}
export function transformRect(frame: Rect, fit: LayoutFit): Rect {
  return {
    x: fit.x + frame.x * fit.scale,
    y: fit.y + frame.y * fit.scale,
    width: frame.width * fit.scale,
    height: frame.height * fit.scale,
  };
}
export function hitRect(
  control: LayoutControl,
  fit: LayoutFit,
  width: number,
  height: number,
): Rect {
  const r = transformRect(control.frame, fit),
    e = control.hitInsets ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const w = Math.min(width, Math.max(44, r.width + (e.left + e.right) * fit.scale)),
    h = Math.min(height, Math.max(44, r.height + (e.top + e.bottom) * fit.scale));
  return {
    x: Math.max(
      0,
      Math.min(width - w, r.x + r.width / 2 - w / 2 + ((e.right - e.left) * fit.scale) / 2),
    ),
    y: Math.max(
      0,
      Math.min(height - h, r.y + r.height / 2 - h / 2 + ((e.bottom - e.top) * fit.scale) / 2),
    ),
    width: w,
    height: h,
  };
}
export function validateLayout(value: unknown): ControllerLayout {
  if (!value || typeof value !== 'object' || JSON.stringify(value).length > 131072)
    throw Error('Layout exceeds limit');
  const d = value as ControllerLayout,
    id = (s: unknown) => typeof s === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(s),
    finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
  if (
    d.version !== 1 ||
    !id(d.id) ||
    typeof d.name !== 'string' ||
    d.name.length > 80 ||
    !Array.isArray(d.assets) ||
    d.assets.length > 32 ||
    !d.representations
  )
    throw Error('Invalid layout');
  const assets = new Set<string>();
  for (const a of d.assets) {
    if (
      !id(a.id) ||
      assets.has(a.id) ||
      !['image/png', 'image/svg+xml', 'application/pdf'].includes(a.mediaType)
    )
      throw Error('Invalid layout asset');
    assets.add(a.id);
  }
  for (const orientation of ['portrait', 'landscape'] as const) {
    const r = d.representations[orientation];
    if (
      !r?.reference ||
      !['overlay', 'underlay'].includes(r.placement) ||
      !finite(r.reference.width) ||
      !finite(r.reference.height) ||
      r.reference.width < 240 ||
      r.reference.height < 200 ||
      r.reference.width > 4096 ||
      r.reference.height > 4096 ||
      !Array.isArray(r.controls) ||
      r.controls.length > 32 ||
      !Array.isArray(r.screens) ||
      r.screens.length !== 1
    )
      throw Error('Unsupported layout representation');
    const rect = (f: Rect, unit = false) => {
      const w = unit ? 1 : r.reference.width,
        h = unit ? 1 : r.reference.height;
      if (
        !f ||
        ![f.x, f.y, f.width, f.height].every(finite) ||
        f.x < 0 ||
        f.y < 0 ||
        f.width <= 0 ||
        f.height <= 0 ||
        f.x + f.width > w + 0.01 ||
        f.y + f.height > h + 0.01
      )
        throw Error('Layout rectangle is outside its reference plane');
    };
    for (const s of r.screens) {
      if (!id(s.id)) throw Error('Invalid screen');
      rect(s.frame);
      if (s.inputFrame) rect(s.inputFrame, true);
    }
    if (r.artwork !== undefined) {
      if (!Array.isArray(r.artwork) || r.artwork.length > 8) throw Error('Invalid artwork');
      for (const a of r.artwork) {
        if (!assets.has(a.assetId)) throw Error('Missing artwork');
        rect(a.frame);
      }
    }
    const seen = new Set<string>();
    for (const c of r.controls) {
      rect(c.frame);
      if (
        !id(c.id) ||
        seen.has(c.id) ||
        ![...actions, 'leftStick', 'rightStick'].includes(c.action) ||
        !finite(c.opacity) ||
        c.opacity < 0.25 ||
        c.opacity > 1 ||
        c.frame.width < 20 ||
        c.frame.height < 20 ||
        c.frame.width > 180 ||
        c.frame.height > 180 ||
        !c.visual
      )
        throw Error('Invalid layout control');
      seen.add(c.id);
      if (
        c.hitInsets &&
        !['top', 'right', 'bottom', 'left'].every(
          (k) =>
            finite(c.hitInsets?.[k as keyof typeof c.hitInsets]) &&
            (c.hitInsets?.[k as keyof typeof c.hitInsets] ?? -1) >= 0 &&
            (c.hitInsets?.[k as keyof typeof c.hitInsets] ?? 99) <= 48,
        )
      )
        throw Error('Invalid hit region');
      if (c.visual.kind === 'shape') {
        if (
          !['circle', 'rect'].includes(c.visual.shape) ||
          typeof c.visual.label !== 'string' ||
          c.visual.label.length > 24
        )
          throw Error('Invalid vector control');
      } else if (c.visual.kind !== 'image' || !assets.has(c.visual.assetId))
        throw Error('Missing control artwork');
    }
  }
  return structuredClone(d);
}
export function defaultLayout(preset: 'compact' | 'standard' = 'compact'): ControllerLayout {
  const representation = (portrait: boolean): LayoutRepresentation => {
    const width = portrait ? 360 : 800,
      height = portrait ? (preset === 'standard' ? 650 : 520) : 450,
      edge = portrait ? 14 : 30;
    const controls: LayoutControl[] = [];
    const add = (action: LayoutAction, x: number, y: number, size = 56) =>
      controls.push({
        id: action,
        action,
        frame: { x, y, width: size, height: size },
        opacity: 0.85,
        visual: {
          kind: 'shape',
          shape: ['up', 'down', 'left', 'right'].includes(action) ? 'rect' : 'circle',
          label:
            (
              {
                up: '↑',
                down: '↓',
                left: '←',
                right: '→',
                select: 'Select',
                start: 'Start',
                leftStick: 'L stick',
                rightStick: 'R stick',
              } as Record<string, string>
            )[action] ?? action.toUpperCase(),
        },
      });
    const cy = portrait ? 390 : 320;
    add('left', edge, cy, 44);
    add('up', edge + 50, cy - 50, 44);
    add('right', edge + 100, cy, 44);
    add('down', edge + 50, cy + 50, 44);
    const right = width - edge - 56;
    add('a', right, portrait ? (preset === 'standard' ? 397 : 337) : 260);
    add('b', right - 60, portrait ? (preset === 'standard' ? 457 : 397) : 320);
    add('select', portrait ? 120 : 330, height - 40, 56);
    add('start', portrait ? 184 : 430, height - 40, 56);
    for (const c of controls)
      if (c.action === 'start' || c.action === 'select') {
        c.frame.height = 32;
        c.visual = {
          kind: 'shape',
          shape: 'rect',
          label: c.action === 'start' ? 'Start' : 'Select',
        };
      }
    if (preset === 'standard') {
      add('x', right - 60, portrait ? 337 : 200);
      add('y', right - 120, portrait ? 397 : 260);
      add('l', edge, portrait ? 282 : 30, 44);
      add('r', width - edge - 44, portrait ? 282 : 30, 44);
      add('l2', edge + 55, portrait ? 282 : 30, 44);
      add('r2', width - edge - 99, portrait ? 282 : 30, 44);
      add('leftStick', portrait ? 24 : 220, portrait ? 526 : 320, 88);
      add('rightStick', portrait ? 248 : 510, portrait ? 526 : 320, 88);
    }
    return {
      reference: { width, height },
      placement: portrait ? 'underlay' : 'overlay',
      screens: [{ id: 'game', frame: { x: 0, y: 0, width, height: portrait ? 270 : height } }],
      controls,
    };
  };
  return validateLayout({
    version: 1,
    id: `builtin-${preset}`,
    name: preset === 'compact' ? 'Compact · 2 buttons' : 'Standard RetroPad',
    assets: [],
    representations: { portrait: representation(true), landscape: representation(false) },
  });
}

/** Preserve control geometry while changing the game plane used by the renderer. */
export function setLayoutPlacement(
  value: LayoutRepresentation,
  placement: 'overlay' | 'underlay',
): LayoutRepresentation {
  const r = structuredClone(value);
  if (r.placement === placement) return r;
  r.placement = placement;
  const screen = r.screens[0];
  if (!screen) throw Error('Game screen unavailable');
  if (placement === 'overlay') {
    screen.frame = { x: 0, y: 0, ...r.reference };
    return r;
  }
  const bottom = Math.max(...r.controls.map((c) => c.frame.y + c.frame.height), 0);
  const gameHeight = Math.max(200, Math.round(r.reference.width * 0.75));
  const minY = r.controls.length ? Math.min(...r.controls.map((c) => c.frame.y)) : 0;
  r.reference.height = Math.max(gameHeight + 200, gameHeight + 28 + bottom - minY);
  screen.frame = { x: 0, y: 0, width: r.reference.width, height: gameHeight };
  for (const c of r.controls) c.frame.y = gameHeight + 14 + c.frame.y - minY;
  return r;
}
