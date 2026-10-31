import type { BrowserCore } from './runtime.js';
export const actions = [
  'b',
  'y',
  'select',
  'start',
  'up',
  'down',
  'left',
  'right',
  'a',
  'x',
  'l',
  'r',
  'l2',
  'r2',
  'l3',
  'r3',
] as const;
export type PadAction = (typeof actions)[number];
export const standardButtons = [0, 2, 8, 9, 12, 13, 14, 15, 1, 3, 4, 5, 6, 7, 10, 11] as const;
export type PadBinding =
  | { kind: 'button'; index: number }
  | { kind: 'axis'; index: number; direction: 1 | -1 };
export interface PortMapping {
  keys: Partial<Record<PadAction, string>>;
  mouse: Partial<Record<PadAction, number>>;
  pads: Partial<Record<PadAction, PadBinding>>;
  axes: { index: number; inverted: boolean }[];
  deadzone: number;
}
export interface MappingConfig {
  version: 1;
  keyboardMode: 'pad' | 'native';
  mouseMode: 'pad' | 'native';
  ports: PortMapping[];
}
export interface InputSource {
  id: string;
  port: number;
  buttons: number;
  axes: number[];
}
export interface TouchPacket {
  sequence: number;
  active: boolean;
  sources: InputSource[];
  cancelled?: string[];
}
export interface DeviceSummary {
  index: number;
  id: string;
  mapping: string;
  buttons: number;
  axes: number;
}
export interface InputCapture {
  kind: 'keyboard' | 'mouse' | 'controller';
  port: number;
}
export interface CapturedBinding {
  kind: 'keyboard' | 'mouse' | 'controller';
  key?: string;
  mouse?: number;
  pad?: PadBinding;
}
export interface InputInfo {
  supported: boolean;
  ready: boolean;
  devices: DeviceSummary[];
  assignments: (number | null)[];
  states: { buttons: number; axes: number[] }[];
  deviceError: string | null;
  capture: CapturedBinding | null;
}
export const defaultKeys: Partial<Record<PadAction, string>> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  a: 'KeyX',
  b: 'KeyZ',
  x: 'KeyS',
  y: 'KeyA',
  l: 'KeyQ',
  r: 'KeyW',
  start: 'Enter',
  select: 'Space',
};
export function defaultMapping(): MappingConfig {
  return {
    version: 1,
    keyboardMode: 'pad',
    mouseMode: 'native',
    ports: Array.from({ length: 4 }, (_, port) => ({
      keys: port === 0 ? { ...defaultKeys } : {},
      mouse: {},
      pads: Object.fromEntries(
        actions.map((a, i) => [a, { kind: 'button', index: standardButtons[i] }]),
      ),
      axes: Array.from({ length: 4 }, (_, index) => ({ index, inverted: false })),
      deadzone: 0.15,
    })),
  };
}
export function actionBit(action: PadAction): number {
  return 1 << actions.indexOf(action);
}
export function verifiedInputBuild(core: BrowserCore): boolean {
  return (
    core.runtime === 'retroarch-emscripten-esm' &&
    core.loader.sha256 === '4198e886f14d2c82a41c6405523f6dc748177bf1a4cadb97e93ce49a77cfcef8' &&
    core.wasm.sha256 === 'c54d033d3f7856074e48bf824bc92b9b2e6f9cf3d529d4d646685ed626d62205'
  );
}
export function nativeInputConfig(): string {
  const lines = ['input_joypad_driver = "rwebpad"'];
  for (let p = 1; p <= 4; p++) {
    lines.push(
      `input_player${p}_joypad_index = "${p - 1}"`,
      `input_player${p}_analog_dpad_mode = "0"`,
    );
    actions.forEach((a, i) => {
      lines.push(`input_player${p}_${a}_btn = "${standardButtons[i]}"`);
    });
    for (const [i, name] of ['l_x', 'l_y', 'r_x', 'r_y'].entries())
      for (const direction of ['plus', 'minus'])
        lines.push(
          `input_player${p}_${name}_${direction}_axis = "${direction === 'plus' ? '+' : '-'}${i}"`,
        );
  }
  for (const key of [
    'save_state',
    'load_state',
    'state_slot_increase',
    'state_slot_decrease',
    'reset',
    'exit_emulator',
    'menu_toggle',
    'pause_toggle',
    'rewind',
    'toggle_fast_forward',
    'hold_fast_forward',
    'screenshot',
    'shader_next',
    'shader_prev',
    'shader_toggle',
    'grab_mouse_toggle',
    'game_focus_toggle',
  ])
    lines.push(`input_${key} = "nul"`);
  return lines.join('\n');
}

/** Touch coordinates map to logical stick axes; physical source indices do not apply. */
export function touchStickAxes(
  x: number,
  y: number,
  right: boolean,
  config: PortMapping,
): number[] {
  const axes = [0, 0, 0, 0],
    offset = right ? 2 : 0,
    d = config.deadzone;
  for (const [i, n] of [x, y].entries())
    axes[offset + i] =
      (Math.abs(n) <= d ? 0 : Math.sign(n) * Math.min(1, (Math.abs(n) - d) / (1 - d))) *
      (config.axes[offset + i]?.inverted ? -1 : 1);
  return axes;
}
