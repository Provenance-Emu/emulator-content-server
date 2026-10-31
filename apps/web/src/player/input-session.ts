import {
  actions,
  type CapturedBinding,
  type DeviceSummary,
  type InputCapture,
  type InputInfo,
  type InputSource,
  type MappingConfig,
  type PadAction,
} from './input-model.js';
import { applyInputPatch, type InputPatch, type InputPreferences } from './input-preferences.js';
import {
  type ControllerLayout,
  defaultLayout,
  type LayoutControl,
  setLayoutPlacement,
  validateLayout,
} from './layout.js';
import type { PlayerRuntime } from './runtime.js';
export class InputSession {
  map: MappingConfig;
  layout: ControllerLayout;
  draft: ControllerLayout | null = null;
  models: (Omit<DeviceSummary, 'index'> | null)[];
  assignments: (number | null)[] = [null, null, null, null];
  info: InputInfo = {
    supported: false,
    ready: false,
    devices: [],
    assignments: [null, null, null, null],
    states: Array.from({ length: 4 }, () => ({ buttons: 0, axes: [0, 0, 0, 0] })),
    deviceError: null,
    capture: null,
  };
  gestureEpoch = 0;
  showTouch = true;
  orientationMode: 'auto' | 'portrait' | 'landscape' = 'auto';
  ready = false;
  busy = false;
  mode: 'play' | 'reference' | 'edit' = 'play';
  orientation: 'portrait' | 'landscape' = 'portrait';
  port = 0;
  selected = 'a';
  bindingAction: PadAction = 'a';
  capture: { kind: InputCapture['kind']; action: PadAction } | null = null;
  message = 'Preparing input adapter…';
  failure: string | null = null;
  private base: InputPatch;
  private changes: InputPatch = {};
  private sources = new Map<string, InputSource>();
  private listeners = new Set<() => void>();
  private sequence = 0;
  private active = false;
  private polling = false;
  private configEpoch = 0;
  private history: ControllerLayout[] = [];
  private assignedModels: (string | null)[] = [null, null, null, null];
  constructor(
    public readonly runtime: PlayerRuntime,
    public readonly store: InputPreferences,
  ) {
    const loaded = store.load();
    this.map = loaded.map;
    this.layout = loaded.layout;
    this.models = loaded.models;
    this.base = loaded.patch;
    this.message = loaded.warning ?? 'Session-only mappings';
  }
  get editLayout() {
    return this.draft ?? this.layout;
  }
  get representation() {
    return this.editLayout.representations[this.orientation];
  }
  get control() {
    return (
      this.representation.controls.find((c) => c.id === this.selected) ??
      this.representation.controls[0]
    );
  }
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  notify() {
    for (const fn of this.listeners) fn();
  }
  async initialize() {
    this.busy = true;
    try {
      if (!this.runtime.inputInfo || !this.runtime.configureInput || !this.runtime.sendInput) {
        this.message = 'Custom mappings are unavailable for this build; native input is unchanged.';
        return;
      }
      const end = Date.now() + 5000;
      do {
        this.info = await this.runtime.inputInfo();
        if (!this.info.supported) break;
        if (this.info.ready) break;
        await new Promise((r) => setTimeout(r, 30));
      } while (Date.now() < end);
      if (!this.info.ready) {
        await this.runtime.disableInput?.();
        this.message =
          'This build has no verified virtual-controller adapter. Native input remains available.';
        return;
      }
      await this.runtime.configureInput(this.map, this.assignments);
      this.ready = true;
      this.message =
        this.store.load().warning ??
        'Session-only mappings. Press a controller button to reveal connected devices.';
    } catch (error) {
      await this.runtime.disableInput?.().catch(() => {});
      this.fail(error);
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  fail(error: unknown) {
    this.failure = error instanceof Error ? error.message : 'Input operation failed';
    this.notify();
  }
  heartbeat(active: boolean) {
    const next = active && this.ready && this.mode !== 'edit' && !this.capture;
    if (this.active && !next) {
      this.gestureEpoch++;
      this.sources.clear();
      this.notify();
    }
    this.active = next;
    if (!this.active) this.sources.clear();
    this.send();
  }
  private send(cancelled?: string[]) {
    try {
      this.runtime.sendInput?.({
        sequence: ++this.sequence,
        active: this.active,
        sources: [...this.sources.values()],
        ...(cancelled ? { cancelled } : {}),
      });
    } catch (error) {
      this.sources.clear();
      this.active = false;
      this.fail(error);
    }
  }
  touch(id: string, buttons: number, axes = [0, 0, 0, 0]) {
    if (!this.ready || this.mode !== 'play' || this.capture) return;
    if (!this.sources.has(id) && this.sources.size >= 16) return;
    const previous = this.sources.get(id);
    if (
      previous &&
      previous.port === this.port &&
      previous.buttons === buttons &&
      previous.axes.every((n, i) => n === axes[i])
    )
      return;
    this.sources.set(id, { id, port: this.port, buttons, axes });
    this.send();
  }
  endTouch(id: string, cancel = false) {
    this.sources.delete(id);
    this.send(cancel ? [id] : undefined);
  }
  releaseAll() {
    this.gestureEpoch++;
    this.sources.clear();
    this.active = false;
    this.send();
    this.info = {
      ...this.info,
      states: Array.from({ length: 4 }, () => ({ buttons: 0, axes: [0, 0, 0, 0] })),
    };
    this.notify();
  }
  setPort(port: number) {
    if (!Number.isInteger(port) || port < 0 || port > 3) return;
    void this.cancelCapture();
    this.configEpoch++;
    this.releaseAll();
    this.port = port;
    this.notify();
  }
  setMode(mode: 'play' | 'reference') {
    this.releaseAll();
    this.draft = null;
    this.mode = mode;
    void this.cancelCapture();
    this.notify();
  }
  beginEdit() {
    this.releaseAll();
    void this.cancelCapture();
    this.draft = structuredClone(this.layout);
    this.history = [];
    this.mode = 'edit';
    this.message = 'Editing releases controls. The game continues running.';
    this.notify();
  }
  checkpoint() {
    if (this.draft) {
      this.history.push(structuredClone(this.draft));
      if (this.history.length > 20) this.history.shift();
    }
  }
  undo() {
    const previous = this.history.pop();
    if (previous) {
      this.draft = previous;
      this.notify();
    }
  }
  changeControl(id: string, patch: Partial<LayoutControl>) {
    if (!this.draft) throw Error('Enter edit mode first');
    const d = structuredClone(this.draft),
      c = d.representations[this.orientation].controls.find((c) => c.id === id);
    if (!c) throw Error('Control unavailable');
    Object.assign(c, patch);
    this.draft = validateLayout(d);
    this.notify();
  }
  addControl() {
    if (!this.draft) return;
    this.checkpoint();
    const d = structuredClone(this.draft),
      r = d.representations[this.orientation];
    if (r.controls.length >= 32) throw Error('Maximum 32 controls');
    let i = 1;
    while (r.controls.some((c) => c.id === `control-${i}`)) i++;
    const id = `control-${i}`;
    r.controls.push({
      id,
      action: 'a',
      frame: {
        x: r.reference.width / 2 - 28,
        y: r.reference.height / 2 - 28,
        width: 56,
        height: 56,
      },
      opacity: 0.85,
      visual: { kind: 'shape', shape: 'circle', label: 'A' },
    });
    this.draft = validateLayout(d);
    this.selected = id;
    this.notify();
  }
  removeControl() {
    if (!this.draft) return;
    this.checkpoint();
    const d = structuredClone(this.draft),
      r = d.representations[this.orientation];
    r.controls = r.controls.filter((c) => c.id !== this.selected);
    this.draft = validateLayout(d);
    this.selected = r.controls[0]?.id ?? '';
    this.notify();
  }
  restorePreset(preset: 'compact' | 'standard') {
    if (!this.draft) this.beginEdit();
    this.checkpoint();
    const d = defaultLayout(preset);
    if (this.draft)
      this.draft = {
        ...this.draft,
        representations: {
          ...this.draft.representations,
          [this.orientation]: d.representations[this.orientation],
        },
      };
    this.selected = 'a';
    this.notify();
  }
  setPlacement(placement: 'overlay' | 'underlay') {
    if (!this.draft) return;
    this.checkpoint();
    const d = structuredClone(this.draft);
    d.representations[this.orientation] = setLayoutPlacement(
      d.representations[this.orientation],
      placement,
    );
    this.draft = validateLayout(d);
    this.notify();
  }
  cancelEdit() {
    this.draft = null;
    this.mode = 'play';
    this.releaseAll();
    this.notify();
  }
  applyEdit() {
    if (!this.draft) return;
    const next = validateLayout(this.draft);
    for (const o of ['portrait', 'landscape'] as const)
      if (
        JSON.stringify(next.representations[o]) !== JSON.stringify(this.layout.representations[o])
      )
        this.changes[`layout.${o}`] = next.representations[o];
    this.layout = next;
    this.draft = null;
    this.mode = 'play';
    this.releaseAll();
    this.message = 'Layout applied for this session.';
    this.notify();
  }
  async update(patch: InputPatch) {
    if (this.busy) throw Error('Wait for the current input operation');
    const candidate = applyInputPatch({ ...this.base, ...this.changes, ...patch });
    this.configEpoch++;
    this.releaseAll();
    this.busy = true;
    this.notify();
    try {
      await this.runtime.configureInput?.(candidate.map, this.assignments);
      this.map = candidate.map;
      this.models = candidate.models;
      this.changes = { ...this.changes, ...patch };
      this.failure = null;
      this.message = 'Mapping applied for this session.';
    } catch (error) {
      this.ready = false;
      throw error;
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  async bind(
    action: PadAction,
    binding: CapturedBinding | null,
    kind: InputCapture['kind'] = 'keyboard',
  ) {
    const type = binding?.kind ?? kind,
      field = type === 'keyboard' ? 'key' : type === 'mouse' ? 'mouse' : 'pad';
    const value =
      type === 'keyboard' ? binding?.key : type === 'mouse' ? binding?.mouse : binding?.pad;
    if (binding) {
      for (let p = 0; p < 4; p++)
        for (const a of actions) {
          if (p === this.port && a === action) continue;
          const previous =
            field === 'key'
              ? this.map.ports[p]?.keys[a]
              : field === 'mouse'
                ? this.map.ports[p]?.mouse[a]
                : this.map.ports[p]?.pads[a];
          if (
            (field === 'key' || p === this.port) &&
            previous !== undefined &&
            JSON.stringify(previous) === JSON.stringify(value)
          )
            throw Error(
              `Already bound to ${a.toUpperCase()} on port ${p + 1}. Clear that binding first.`,
            );
        }
    }
    await this.cancelCapture();
    await this.update({ [`${field}.${this.port}.${action}`]: binding ? value : null });
  }
  async assign(index: number | null) {
    if (index !== null && this.assignments.some((n, p) => p !== this.port && n === index))
      throw Error('Controller already assigned to another port');
    const d = this.info.devices.find((d) => d.index === index);
    if (index !== null && !d) throw Error('Controller disconnected');
    if (this.busy) throw Error('Wait for the current input operation');
    this.busy = true;
    this.configEpoch++;
    this.releaseAll();
    try {
      const next = [...this.assignments];
      next[this.port] = index;
      await this.runtime.configureInput?.(this.map, next, this.port);
      this.assignments = next;
      this.assignedModels[this.port] = d
        ? JSON.stringify({ id: d.id, mapping: d.mapping, buttons: d.buttons, axes: d.axes })
        : null;
      this.models[this.port] = d
        ? { id: d.id, mapping: d.mapping, buttons: d.buttons, axes: d.axes }
        : null;
      this.changes[`device.${this.port}`] = this.models[this.port];
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  async startCapture(kind: InputCapture['kind'], action: PadAction) {
    if (this.mode === 'edit') throw Error('Finish layout editing before rebinding');
    this.releaseAll();
    this.failure = null;
    this.configEpoch++;
    this.capture = { kind, action };
    this.notify();
    await this.runtime.captureInput?.({ kind, port: this.port });
  }
  async cancelCapture() {
    if (this.capture) {
      this.configEpoch++;
      this.capture = null;
      await this.runtime.captureInput?.(null);
      this.notify();
    }
  }
  async poll() {
    if (!this.ready || this.busy || this.polling) return;
    this.polling = true;
    const epoch = this.configEpoch;
    try {
      const info = await this.runtime.inputInfo?.();
      if (!info || epoch !== this.configEpoch || this.busy) return;
      this.info = info;
      let changed = false;
      for (let p = 0; p < 4; p++) {
        const index = this.assignments[p];
        const expected = this.assignedModels[p];
        if (index !== null) {
          if (info.assignments[p] !== index) {
            this.assignments[p] = null;
            changed = true;
            continue;
          }
          const d = info.devices.find((d) => d.index === index);
          if (
            !d ||
            JSON.stringify({ id: d.id, mapping: d.mapping, buttons: d.buttons, axes: d.axes }) !==
              expected
          ) {
            this.assignments[p] = null;
            changed = true;
          }
        }
      }
      if (changed) {
        this.releaseAll();
        await this.runtime.configureInput?.(this.map, this.assignments);
      }
      if (this.capture && info.capture) {
        const action = this.capture.action;
        await this.bind(action, info.capture);
      }
    } catch (error) {
      await this.cancelCapture().catch(() => {});
      this.fail(error);
    } finally {
      this.polling = false;
      this.notify();
    }
  }
  remember(scope: 'core' | 'game') {
    if (!this.ready || this.draft) throw Error('Apply or cancel layout edits first');
    this.store.remember(scope, this.changes);
    this.message = `Remembered input changes for this ${scope}.`;
    this.notify();
  }
  clearPreferences(scope: 'core' | 'game') {
    this.store.clear(scope);
    this.message =
      'Stored input preferences cleared. Running mappings stay until changed or a fresh launch.';
    this.notify();
  }
  async resetMappings() {
    const patch: InputPatch = {};
    const defaults = applyInputPatch({}).map.ports[this.port];
    if (!defaults) return;
    for (const a of actions) {
      patch[`key.${this.port}.${a}`] = defaults.keys[a] ?? null;
      patch[`mouse.${this.port}.${a}`] = null;
      patch[`pad.${this.port}.${a}`] = defaults.pads[a] ?? null;
    }
    patch[`deadzone.${this.port}`] = 0.15;
    for (let a = 0; a < 4; a++) patch[`axis.${this.port}.${a}`] = defaults.axes[a];
    await this.update(patch);
  }
}
