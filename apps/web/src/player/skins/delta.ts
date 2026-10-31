import { actions, type PadAction } from '../input-model.js';
import {
  defaultLayout,
  type LayoutControl,
  type LayoutRepresentation,
  type Rect,
  validateLayout,
} from '../layout.js';
import {
  type Orientation,
  type SkinAsset,
  type SkinPackage,
  type SkinSelection,
  type SkinVariant,
  skinSystem,
} from './types.js';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const text = (v: unknown, max = 120) => (typeof v === 'string' ? v.slice(0, max) : '');
const nativeSizes: Record<string, [number, number]> = {
  nes: [256, 240],
  snes: [256, 224],
  gbc: [160, 144],
  gba: [240, 160],
  nds: [256, 384],
  n64: [256, 224],
};
const hostActions = new Set([
  'menu',
  'quickSave',
  'quickLoad',
  'fastForward',
  'toggleFastForward',
  'screenshot',
  'holdButtons',
  'reverseScreens',
]);
export function deltaRect(v: unknown): Rect {
  const r = Array.isArray(v) ? { x: v[0], y: v[1], width: v[2], height: v[3] } : object(v);
  const values = [r.x, r.y, r.width, r.height];
  if (
    values.some((n) => typeof n !== 'number' || !Number.isFinite(n)) ||
    Number(r.width) <= 0 ||
    Number(r.height) <= 0
  )
    throw Error('Invalid skin rectangle');
  return { x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height) };
}
export function convertDelta(
  info: unknown,
  resolve: (name: string) => SkinAsset,
): Pick<SkinPackage, 'name' | 'author' | 'system' | 'variants'> {
  const root = object(info),
    system = skinSystem(text(root.gameTypeIdentifier)),
    name = text(root.name, 80);
  if (!name || !text(root.identifier) || !system) throw Error('Not a Delta info.json package');
  const variants: SkinVariant[] = [];
  for (const [device, displays] of Object.entries(object(root.representations)))
    for (const [display, orientations] of Object.entries(object(displays)))
      for (const orientation of ['portrait', 'landscape'] as const) {
        const raw = object(object(orientations)[orientation]);
        if (!Object.keys(raw).length) continue;
        if (variants.length >= 24) throw Error('Too many skin representations');
        const ref = object(raw.mappingSize);
        if (!Number.isFinite(ref.width) || !Number.isFinite(ref.height))
          throw Error('Skin mappingSize is missing');
        const reference = { width: Number(ref.width), height: Number(ref.height) },
          issues: string[] = [];
        let live = true;
        const assets = object(raw.assets),
          assetName = text(assets.resizable || assets.large || assets.medium || assets.small, 240);
        let asset: SkinAsset | undefined;
        if (!assetName || !/\.(png|pdf)$/i.test(assetName)) {
          live = false;
          issues.push('Missing or unsupported PNG/PDF artwork.');
        } else asset = resolve(assetName);
        const screens: LayoutRepresentation['screens'] = [];
        const rawScreens = Array.isArray(raw.screens)
          ? raw.screens
          : raw.gameScreenFrame
            ? [{ outputFrame: raw.gameScreenFrame }]
            : [{}];
        if (rawScreens.length < 1 || rawScreens.length > 2) {
          live = false;
          issues.push('This screen count is not supported for live playback.');
        }
        for (const [s, item] of rawScreens.slice(0, 2).entries()) {
          const screen = object(item);
          const frame = screen.outputFrame
            ? deltaRect(screen.outputFrame)
            : { x: 0, y: 0, ...reference };
          let inputFrame: Rect | undefined;
          if (screen.inputFrame) {
            const crop = deltaRect(screen.inputFrame),
              size = nativeSizes[system];
            if (size)
              inputFrame = {
                x: crop.x / size[0],
                y: crop.y / size[1],
                width: crop.width / size[0],
                height: crop.height / size[1],
              };
            else {
              live = false;
              issues.push('Source crop dimensions are not known for this system.');
            }
          }
          if (
            inputFrame &&
            (inputFrame.x !== 0 ||
              inputFrame.y !== 0 ||
              inputFrame.width !== 1 ||
              inputFrame.height !== 1)
          ) {
            live = false;
            issues.push('Cropped game screens are preview-only.');
          }
          if (Array.isArray(screen.filters) && screen.filters.length) {
            live = false;
            issues.push('CoreImage screen filters are not supported.');
          }
          screens.push({ id: 'screen-' + s, frame, ...(inputFrame ? { inputFrame } : {}) });
        }
        if (screens.length !== 1) {
          live = false;
          issues.push('Multiple game screens are preview-only.');
        }
        const controls: LayoutControl[] = [];
        if (!Array.isArray(raw.items) || raw.items.length > 32)
          throw Error('Skin control count exceeds limit');
        for (const [i, item] of raw.items.entries()) {
          const c = object(item),
            input = c.inputs,
            frame = deltaRect(c.frame);
          let action: LayoutControl['action'] | undefined, buttons: PadAction[] | undefined;
          if (
            Array.isArray(input) &&
            input.length &&
            input.length <= 16 &&
            input.every((v) => typeof v === 'string')
          ) {
            const values = input as string[];
            if (values.every((v) => actions.includes(v as PadAction))) {
              buttons = [...new Set(values)] as PadAction[];
              action = buttons.length === 1 ? buttons[0] : 'combo';
            } else if (values.every((v) => hostActions.has(v))) {
              issues.push(`Inactive ${values.join('/')} control: use the player toolbar.`);
            } else {
              live = false;
              issues.push(`Unsupported control: ${values.join('/').slice(0, 100)}`);
            }
          } else {
            const axis = object(input);
            if (
              axis.up === 'up' &&
              axis.down === 'down' &&
              axis.left === 'left' &&
              axis.right === 'right'
            )
              action = 'dpad';
            else if (
              (axis.x === 'analogStickX' || axis.x === 'leftAnalogStickX') &&
              (axis.y === 'analogStickY' || axis.y === 'leftAnalogStickY')
            )
              action = 'leftStick';
            else if (axis.x === 'rightAnalogStickX' && axis.y === 'rightAnalogStickY')
              action = 'rightStick';
            else {
              live = false;
              issues.push('Unsupported directional, touch or analog control.');
            }
          }
          if (!action) continue;
          const edges = { ...object(raw.extendedEdges), ...object(c.extendedEdges) };
          const hitInsets = {
            top: Number(edges.top ?? 0),
            right: Number(edges.right ?? 0),
            bottom: Number(edges.bottom ?? 0),
            left: Number(edges.left ?? 0),
          };
          controls.push({
            id: 'item-' + i,
            action,
            ...(action === 'combo' ? { buttons } : {}),
            frame,
            hitInsets,
            opacity: 1,
            visual: { kind: 'hotspot' },
          });
        }
        if (!controls.length) {
          live = false;
          issues.push('No supported gameplay controls.');
        }
        const representation: LayoutRepresentation = {
          reference,
          placement: 'underlay',
          screens: screens.length ? screens : [{ id: 'game', frame: { x: 0, y: 0, ...reference } }],
          ...(asset
            ? { artwork: [{ assetId: asset.id, frame: { x: 0, y: 0, ...reference } }] }
            : {}),
          controls,
        };
        const doc = defaultLayout();
        doc.assets = asset ? [{ id: asset.id, mediaType: asset.mediaType }] : [];
        doc.representations[orientation] = representation;
        validateLayout(doc);
        variants.push({
          key: `${device}/${display}/${orientation}`,
          device: text(device, 40),
          display: text(display, 40),
          orientation,
          representation,
          issues: [...new Set(issues)],
          live,
        });
      }
  if (!variants.length) throw Error('No supported orientation representations');
  return { name, author: text(root.author), system, variants };
}
export function selectSkinLayout(
  pkg: SkinPackage,
  choices: Partial<Record<Orientation, string>>,
  device = 'iphone',
): SkinSelection {
  const layout = defaultLayout();
  layout.id = 'skin-' + pkg.id.slice(0, 32);
  layout.name = pkg.name;
  layout.assets = pkg.assets.map(({ id, mediaType }) => ({ id, mediaType }));
  const issues: string[] = [];
  const selected: Partial<Record<Orientation, string>> = {};
  let live = true;
  for (const o of ['portrait', 'landscape'] as const) {
    const candidates = pkg.variants.filter((v) => v.orientation === o),
      chosen = choices[o];
    const v = chosen
      ? candidates.find((v) => v.key === chosen)
      : (candidates.find((v) => v.device === device && v.display === 'edgeToEdge') ??
        candidates.find((v) => v.device === device && v.display === 'standard') ??
        candidates.find((v) => v.display === 'standard' || v.display === 'edgeToEdge'));
    if (v) {
      selected[o] = v.key;
      layout.representations[o] = structuredClone(v.representation);
      issues.push(...v.issues.map((s) => `${o}: ${s}`));
      live &&= v.live;
    } else {
      issues.push(`${o}: procedural fallback; this skin has no matching representation.`);
      if (chosen) live = false;
    }
  }
  return { layout: validateLayout(layout), issues: [...new Set(issues)], live, selected };
}
