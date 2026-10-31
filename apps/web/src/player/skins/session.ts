import type { InputSession } from '../input-session.js';
import { type ControllerLayout, defaultLayout, validateLayout } from '../layout.js';
import { type RenderedAsset, renderSkinAsset } from './artwork.js';
import { selectSkinLayout } from './delta.js';
import { importSkin } from './import-client.js';
import { type SkinLibrary, validatePreference } from './library.js';
import { type Orientation, type SkinPackage, type SkinPreference, skinSystem } from './types.js';
export class SkinSession {
  items: SkinPackage[] = [];
  previewPackage: SkinPackage | null = null;
  previewLayout: ControllerLayout | null = null;
  previewChoices: Partial<Record<Orientation, string>> = {};
  previewIssues: string[] = [];
  previewLive = false;
  previewOrientation: Orientation = 'portrait';
  previewAssets: Record<string, string> = {};
  assets: Record<string, string> = {};
  active: SkinPackage | null = null;
  basis = 'builtin-compact';
  choices: Partial<Record<Orientation, string>> = {};
  busy = false;
  progress = 0;
  error: string | null = null;
  message = 'Local skins are session-only until remembered.';
  presentationOpen = false;
  private listeners = new Set<() => void>();
  private generation = 0;
  private operation: AbortController | null = null;
  private previewRendered: RenderedAsset[] = [];
  private activeRendered: RenderedAsset[] = [];
  private unsub: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private channel: BroadcastChannel | null = null;
  private applying = false;
  private observed: string[] = [];
  private edited: SkinPreference['overrides'] = {};
  private selectionDirty = false;
  private installed = new Set<string>();
  private closed = false;
  private persistence: Promise<void> = Promise.resolve();
  private checking = false;
  constructor(
    public input: InputSession,
    public library: SkinLibrary,
    private scope: string,
    public game: string | undefined,
    public system: string,
    private options: { render?: typeof renderSkinAsset; importer?: typeof importSkin } = {},
  ) {
    this.system = skinSystem(system);
    this.observe();
    this.unsub = input.subscribe(() => this.observe());
    input.layoutPort = { remember: (s) => this.remember(s), clear: (s) => this.clear(s) };
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
  private observe() {
    for (const [o, i] of (['portrait', 'landscape'] as const).map((o, i) => [o, i] as const)) {
      const current = JSON.stringify(this.input.layout.representations[o]);
      if (!this.applying && this.observed[i] !== undefined && current !== this.observed[i])
        this.edited[o] = structuredClone(this.input.layout.representations[o]);
      this.observed[i] = current;
    }
  }
  private key(scope: 'core' | 'game') {
    if (scope === 'game' && !this.game) throw Error('No game selected');
    return scope === 'core' ? this.scope : this.scope + ':' + this.game;
  }
  private start() {
    this.operation?.abort();
    const controller = new AbortController();
    this.operation = controller;
    const generation = ++this.generation;
    this.busy = true;
    this.error = null;
    this.notify();
    return { signal: controller.signal, generation };
  }
  private current(g: number) {
    if (this.closed || g !== this.generation)
      throw new DOMException('Skin operation replaced', 'AbortError');
  }
  private finish(g: number) {
    if (g === this.generation) {
      this.busy = false;
      this.notify();
    }
  }
  fail(e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') return;
    this.error = e instanceof Error ? e.message.slice(0, 400) : 'Skin operation failed';
    this.notify();
  }
  async initialize() {
    try {
      await this.refresh();
      if (this.closed) return;
      let loaded: SkinPreference | undefined;
      let pkg: SkinPackage | undefined;
      for (const scope of ['core', ...(this.game ? ['game'] : [])] as ('core' | 'game')[])
        try {
          const p = await this.library.getPreference(this.key(scope));
          if (!p) continue;
          const candidate =
            loaded?.basis === p.basis
              ? {
                  ...p,
                  choices: { ...loaded.choices, ...p.choices },
                  overrides: { ...loaded.overrides, ...p.overrides },
                }
              : p;
          const basis = candidate.basis.startsWith('builtin-')
            ? undefined
            : await this.library.get(candidate.basis);
          validatePreference(candidate, basis);
          loaded = candidate;
          pkg = basis;
        } catch {
          this.message = 'Some remembered skins are unavailable; the last usable layout remains.';
        }
      if (loaded) {
        const selection = pkg
          ? selectSkinLayout(pkg, loaded.choices)
          : {
              layout: defaultLayout(loaded.basis === 'builtin-standard' ? 'standard' : 'compact'),
              live: true,
              issues: [],
            };
        if (pkg?.system !== this.system && pkg)
          throw Error('Remembered skin does not match this game system');
        if (!selection.live) throw Error('Remembered skin is not supported for live playback');
        for (const o of ['portrait', 'landscape'] as const)
          if (loaded.overrides[o]) selection.layout.representations[o] = loaded.overrides[o]!;
        if (this.input.ready)
          await this.activate(
            validateLayout(selection.layout),
            pkg ?? null,
            loaded.basis,
            loaded.choices,
            false,
          );
      }
    } catch (e) {
      this.message =
        'Local skin storage is unavailable. Import and play still work for this session.';
      this.fail(e);
    } finally {
      if (!this.closed) {
        this.timer = setInterval(() => void this.checkLibrary(), 3000);
        if (typeof BroadcastChannel !== 'undefined') {
          this.channel = new BroadcastChannel('ecs.skins.v1');
          this.channel.onmessage = () => void this.checkLibrary();
        }
      }
      this.notify();
    }
  }
  async refresh() {
    this.items = await this.library.list();
    this.installed = new Set(this.items.map((p) => p.id));
    this.notify();
  }
  open() {
    void this.input.cancelCapture();
    this.presentationOpen = true;
    this.input.presentationBusy = true;
    this.input.releaseAll();
    this.notify();
  }
  close() {
    this.cancel();
    this.presentationOpen = false;
    this.input.presentationBusy = false;
    this.input.releaseAll();
    this.notify();
  }
  cancel() {
    this.operation?.abort();
    this.generation++;
    this.busy = false;
    this.clearPreview();
    this.notify();
  }
  private clearPreview() {
    for (const r of this.previewRendered) r.release();
    this.previewRendered = [];
    this.previewAssets = {};
    this.previewPackage = null;
    this.previewLayout = null;
  }
  async import(file: Blob) {
    const op = this.start();
    try {
      const pkg = await (this.options.importer ?? importSkin)(file, op.signal, (n) => {
        this.progress = Math.round(n * 100);
        this.notify();
      });
      this.current(op.generation);
      await this.makePreview(pkg, {}, op);
      this.message = 'Package inspected. Preview it before applying or keeping it locally.';
    } catch (e) {
      if (op.generation === this.generation) this.fail(e);
    } finally {
      this.finish(op.generation);
    }
  }
  async preview(
    pkg: SkinPackage,
    choices: Partial<Record<Orientation, string>>,
    orientation: Orientation = this.input.orientation,
  ) {
    const op = this.start();
    try {
      await this.makePreview(pkg, choices, op, orientation);
    } catch (e) {
      if (op.generation === this.generation) this.fail(e);
    } finally {
      this.finish(op.generation);
    }
  }
  private async prepare(
    layout: ControllerLayout,
    pkg: SkinPackage | null,
    signal: AbortSignal,
    orientation?: Orientation,
  ) {
    const ids = new Set(
        (orientation
          ? [layout.representations[orientation]]
          : Object.values(layout.representations)
        ).flatMap((r) => (r.artwork ?? []).map((a) => a.assetId)),
      ),
      rendered: RenderedAsset[] = [],
      urls: Record<string, string> = {};
    try {
      for (const id of ids) {
        signal.throwIfAborted();
        const asset = pkg?.assets.find((a) => a.id === id);
        if (!asset) throw Error('Skin artwork is missing');
        const r = await (this.options.render ?? renderSkinAsset)(asset, signal);
        rendered.push(r);
        urls[id] = r.url;
      }
      signal.throwIfAborted();
      return { rendered, urls };
    } catch (e) {
      for (const r of rendered) r.release();
      throw e;
    }
  }
  private async makePreview(
    pkg: SkinPackage,
    choices: Partial<Record<Orientation, string>>,
    op: { signal: AbortSignal; generation: number },
    orientation: Orientation = this.input.orientation,
  ) {
    const selection = selectSkinLayout(pkg, choices),
      prepared = await this.prepare(selection.layout, pkg, op.signal, orientation);
    try {
      this.current(op.generation);
    } catch (e) {
      for (const r of prepared.rendered) r.release();
      throw e;
    }
    this.clearPreview();
    this.previewPackage = pkg;
    this.previewOrientation = orientation;
    this.previewChoices = { ...selection.selected };
    this.previewLayout = selection.layout;
    this.previewIssues = selection.issues;
    this.previewLive = selection.live && pkg.system === this.system;
    this.previewRendered = prepared.rendered;
    this.previewAssets = prepared.urls;
    if (pkg.system !== this.system)
      this.previewIssues.push(
        `This skin is for ${pkg.system}; the current game is ${this.system}.`,
      );
    this.notify();
  }
  async apply() {
    const pkg = this.previewPackage,
      layout = this.previewLayout;
    if (!pkg || !layout || !this.previewLive || !this.input.ready)
      throw Error('This skin is preview-only for the current player');
    await this.activate(layout, pkg, pkg.id, this.previewChoices, true);
    this.close();
    this.message = 'Skin applied for this session. The game continues running.';
    this.notify();
  }
  private async activate(
    layout: ControllerLayout,
    pkg: SkinPackage | null,
    basis: string,
    choices: Partial<Record<Orientation, string>>,
    dirty: boolean,
  ) {
    for (const r of Object.values(layout.representations))
      if (
        r.screens.length !== 1 ||
        r.screens.some(
          (s) =>
            s.inputFrame &&
            (s.inputFrame.x !== 0 ||
              s.inputFrame.y !== 0 ||
              s.inputFrame.width !== 1 ||
              s.inputFrame.height !== 1),
        )
      )
        throw Error('This screen layout is preview-only');
    const op = this.start();
    let next: Awaited<ReturnType<SkinSession['prepare']>> | null = null;
    try {
      next = await this.prepare(layout, pkg, op.signal);
      this.current(op.generation);
      this.input.releaseAll();
      await this.input.cancelCapture();
      this.current(op.generation);
      this.applying = true;
      this.input.layout = validateLayout(layout);
      this.input.draft = null;
      this.input.mode = 'play';
      this.active = pkg;
      this.basis = basis;
      this.choices = pkg ? { ...selectSkinLayout(pkg, choices).selected } : {};
      for (const r of this.activeRendered) r.release();
      this.activeRendered = next.rendered;
      this.assets = next.urls;
      next = null;
      this.edited = {};
      this.selectionDirty = dirty;
      this.observe();
      this.input.notify();
    } finally {
      this.applying = false;
      if (next) for (const r of next.rendered) r.release();
      this.finish(op.generation);
    }
  }
  async useBuiltin(preset: 'compact' | 'standard') {
    await this.activate(defaultLayout(preset), null, 'builtin-' + preset, {}, true);
    this.message = 'Procedural layout applied for this session.';
    this.notify();
  }
  async resetOriginal() {
    if (this.active) {
      const selection = selectSkinLayout(this.active, this.choices);
      await this.activate(selection.layout, this.active, this.basis, this.choices, true);
    } else await this.useBuiltin(this.basis === 'builtin-standard' ? 'standard' : 'compact');
  }
  async install() {
    if (!this.previewPackage) throw Error('Choose a skin first');
    await this.library.put(this.previewPackage);
    await this.refresh();
    this.message = 'Skin kept in this browser’s library.';
    this.notify();
  }
  async remember(scope: 'core' | 'game', force = false) {
    if (!force && !this.selectionDirty && !Object.keys(this.edited).length) return;
    if (this.input.draft) throw Error('Apply or cancel layout edits first');
    if (this.busy) throw Error('Wait for the current skin operation');
    const generation = ++this.generation,
      pkg = this.active,
      basis = this.basis,
      choices = { ...this.choices },
      dirty = this.selectionDirty,
      key = this.key(scope);
    let edited = structuredClone(this.edited);
    if (force) {
      const original = pkg
        ? selectSkinLayout(pkg, choices).layout
        : defaultLayout(basis === 'builtin-standard' ? 'standard' : 'compact');
      edited = {};
      for (const o of ['portrait', 'landscape'] as const)
        if (
          JSON.stringify(original.representations[o]) !==
          JSON.stringify(this.input.layout.representations[o])
        )
          edited[o] = structuredClone(this.input.layout.representations[o]);
    }
    this.busy = true;
    this.notify();
    const write = this.persistence
      .catch(() => {})
      .then(async () => {
        if (pkg) await this.library.put(pkg);
        const old = await this.library.getPreference(key),
          same = !dirty && !force && old?.basis === basis;
        await this.library.putPreference(key, {
          basis,
          choices: {
            ...(same ? old?.choices : {}),
            ...(dirty || force
              ? choices
              : Object.fromEntries(
                  Object.keys(edited).flatMap((o) => {
                    const key = o as Orientation;
                    return choices[key] ? [[key, choices[key]]] : [];
                  }),
                )),
          },
          overrides: { ...(same ? old?.overrides : {}), ...edited },
        });
      });
    this.persistence = write;
    try {
      await write;
      if (generation === this.generation) {
        if (pkg) this.installed.add(pkg.id);
        this.selectionDirty = false;
        for (const orientation of ['portrait', 'landscape'] as const)
          if (JSON.stringify(this.edited[orientation]) === JSON.stringify(edited[orientation]))
            delete this.edited[orientation];
        this.message = `Skin selection and edits remembered for this ${scope}.`;
        this.channel?.postMessage('changed');
      }
    } finally {
      this.finish(generation);
    }
  }
  async clear(scope: 'core' | 'game') {
    const key = this.key(scope);
    const write = this.persistence.catch(() => {}).then(() => this.library.clearPreference(key));
    this.persistence = write;
    await write;
    this.message = 'Stored skin selection cleared. The running layout stays until changed.';
    this.notify();
  }
  async remove(id: string) {
    const write = this.persistence
      .catch(() => {})
      .then(async () => {
        if (this.active?.id === id) await this.useBuiltin('compact');
        await this.library.remove(id);
      });
    this.persistence = write;
    await write;
    this.channel?.postMessage('changed');
    await this.refresh();
    this.message = 'Local skin removed.';
    this.notify();
  }
  async checkLibrary() {
    if (this.checking || this.closed) return;
    this.checking = true;
    try {
      if (
        this.active &&
        this.installed.has(this.active.id) &&
        !(await this.library.get(this.active.id))
      ) {
        await this.useBuiltin('compact');
        this.message =
          'The selected skin was removed in another tab. Procedural controls restored.';
        this.notify();
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.checking = false;
    }
  }
  dispose() {
    this.closed = true;
    this.operation?.abort();
    this.generation++;
    this.unsub();
    if (this.timer) clearInterval(this.timer);
    this.channel?.close();
    for (const r of [...this.previewRendered, ...this.activeRendered]) r.release();
    this.library.close();
    this.input.layoutPort = undefined;
    this.input.presentationBusy = false;
    this.input.releaseAll();
    this.listeners.clear();
  }
}
