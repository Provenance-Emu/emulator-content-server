import type { Asset, UploadRequest } from '@ecs/client';
import type { CommandChannel } from './commands.js';
import type { PlayerClient } from './controller.js';
import { pngInfo } from './images.js';
import { SAVE_LIMIT } from './preflight.js';
import { type BrowserCore, type PlayerRuntime, paths } from './runtime.js';
import { captureKey, stateCompatibility, statePath } from './states.js';
export type SaveKind = 'battery_save' | 'save_state';
export interface SaveTarget {
  core?: BrowserCore;
  profileId?: string;
  coreName?: string;
  buildVersion?: string;
  libraryId: string;
  itemId: string;
  revision: number;
  batteryPath?: string;
  statePath?: string;
  selectedState?: Uint8Array<ArrayBuffer>;
}
type CapturedUpload = Omit<UploadRequest, 'body' | 'kind'> & {
  kind: SaveKind | 'screenshot';
  body: Uint8Array<ArrayBuffer>;
};
/** The gameplay baseline belongs to the bytes loaded at start, never a polled manifest. */
export class SaveSynchronizer {
  private request: CapturedUpload | null = null;
  private queuedPreview: Uint8Array<ArrayBuffer> | null = null;
  private previewRequest = false;
  private rejectedImage = false;
  private working = false;
  private baseline: number;
  lastConflict: Asset | null = null;
  lastState: Asset | null = null;
  previewWarning: string | null = null;
  constructor(
    private readonly client: Pick<PlayerClient, 'upload' | 'manifest' | 'collect'>,
    private readonly runtime: PlayerRuntime,
    private readonly commands: CommandChannel,
    private readonly target: SaveTarget,
  ) {
    this.baseline = target.revision;
  }
  get busy(): boolean {
    return this.working;
  }
  get pending() {
    const request = this.request;
    return request
      ? {
          kind: request.kind,
          relativePath: request.relativePath,
          baseRevision: request.baseRevision,
          size: request.body.byteLength,
          preview: this.previewRequest,
          canRetry: !this.rejectedImage,
        }
      : null;
  }
  exportPending(): Uint8Array<ArrayBuffer> {
    if (!this.request) throw new Error('No pending save to export');
    return this.request.body.slice();
  }
  private available(): void {
    if (this.working) throw new Error('A save operation is already in progress');
    if (this.request)
      throw new Error(
        'A pending save must be retried or exported before another capture. Reload to discard.',
      );
  }
  async capture(kind: SaveKind): Promise<Asset> {
    this.available();
    this.working = true;
    this.previewWarning = null;
    try {
      await this.runtime.focus?.();
      let previewReady = false;
      if (kind === 'save_state' && this.target.core && this.runtime.prepareStatePreview) {
        try {
          previewReady = await this.runtime.prepareStatePreview();
        } catch {
          this.previewWarning = 'State preview could not be prepared.';
        }
      }
      await this.commands.run(kind === 'battery_save' ? 'SAVE_FILES' : 'SAVE_STATE_SLOT 0');
      const file = await this.runtime.FS.readFile(paths[kind]);
      if (!(file instanceof Uint8Array) || file.byteLength <= 0 || file.byteLength > SAVE_LIMIT)
        throw new Error('Completed save is missing or exceeds the save size limit');
      const body = new Uint8Array(file);
      this.queuedPreview = null;
      if (kind === 'save_state' && this.target.core) {
        if (previewReady && this.runtime.captureStatePreview) {
          try {
            const bytes = await this.runtime.captureStatePreview();
            if (bytes) {
              pngInfo(bytes, 2 * 1024 * 1024);
              this.queuedPreview = new Uint8Array(bytes);
            }
          } catch {
            /* The acknowledged state is still valid. */
          }
        }
        if (!this.queuedPreview)
          this.previewWarning =
            'State saved without a preview. The core did not produce a complete thumbnail.';
      }
      const relativePath =
        kind === 'save_state' && this.target.core
          ? statePath(this.target.core)
          : ((kind === 'battery_save' ? this.target.batteryPath : this.target.statePath) ??
            `browser-${this.target.profileId?.replace(/[^a-z0-9_.-]/gi, '_') ?? 'fceumm'}/game.${kind === 'battery_save' ? 'srm' : 'state'}`);
      this.request = {
        libraryId: this.target.libraryId,
        itemId: this.target.itemId,
        kind,
        displayName:
          kind === 'save_state'
            ? `${this.target.coreName ?? 'Emulator'} state · ${new Date().toISOString()}`.slice(
                0,
                240,
              )
            : `${this.target.coreName ?? 'FCEUmm'} battery save`.slice(0, 240),
        relativePath,
        baseRevision: this.baseline,
        body,
        idempotencyKey: `browser-${captureKey()}`,
      };
      this.previewRequest = false;
      this.rejectedImage = false;
      return await this.uploadPending();
    } finally {
      this.working = false;
    }
  }
  async retry(): Promise<Asset> {
    if (this.working) throw new Error('A save operation is already in progress');
    if (!this.request) throw new Error('No pending save');
    if (this.rejectedImage)
      throw new Error('The item changed. Download or dismiss the pending image.');
    this.working = true;
    try {
      return await this.uploadPending();
    } finally {
      this.working = false;
    }
  }
  dismissPendingImage(): void {
    if (this.working || this.request?.kind !== 'screenshot')
      throw new Error('Only a pending image may be dismissed');
    const wasPreview = this.previewRequest;
    this.request = null;
    this.rejectedImage = false;
    this.previewRequest = false;
    this.previewWarning = wasPreview ? 'State saved without its preview.' : null;
  }
  private async uploadPending(): Promise<Asset> {
    const request = this.request;
    if (!request) throw new Error('No pending save');
    let asset: Asset;
    try {
      asset = await this.client.upload(request);
    } catch (error) {
      if (request.kind === 'screenshot' && (error as { status?: number })?.status === 409)
        this.rejectedImage = true;
      throw error;
    }
    if (request.kind !== 'screenshot') this.lastConflict = asset.conflictOf ? asset : null;
    if (!asset.conflictOf) this.baseline += 1;
    this.request = null;
    this.rejectedImage = false;
    if (request.kind === 'save_state') {
      this.lastState = asset;
      if (this.queuedPreview) {
        const body = this.queuedPreview;
        this.queuedPreview = null;
        this.request = {
          libraryId: this.target.libraryId,
          itemId: this.target.itemId,
          kind: 'screenshot',
          displayName: `${request.displayName} preview`.slice(0, 240),
          relativePath: `${asset.relativePath}.png`,
          baseRevision: this.baseline,
          body,
          idempotencyKey: `browser-${captureKey()}`,
        };
        this.previewRequest = true;
        try {
          await this.uploadPending();
          this.previewWarning = null;
        } catch {
          this.previewWarning = this.rejectedImage
            ? 'State saved. The library changed before its preview could be uploaded.'
            : 'State saved. Its preview upload is pending; retry or download it.';
        }
      }
    } else if (request.kind === 'screenshot') {
      this.previewRequest = false;
      this.previewWarning = null;
    }
    return asset;
  }
  async screenshot(): Promise<Uint8Array<ArrayBuffer>> {
    this.available();
    this.working = true;
    try {
      await this.runtime.focus?.();
      if (!this.runtime.captureScreenshot)
        throw new Error('Screenshots are unavailable for this runtime');
      const bytes = await this.runtime.captureScreenshot();
      pngInfo(bytes);
      return new Uint8Array(bytes);
    } finally {
      this.working = false;
    }
  }
  async saveScreenshot(bytes: Uint8Array): Promise<Asset> {
    this.available();
    pngInfo(bytes);
    this.working = true;
    try {
      this.previewRequest = false;
      this.rejectedImage = false;
      this.request = {
        libraryId: this.target.libraryId,
        itemId: this.target.itemId,
        kind: 'screenshot',
        displayName: `Screenshot · ${new Date().toISOString()}`,
        relativePath: `browser-screenshots/${Date.now()}-${captureKey()}.png`,
        baseRevision: this.baseline,
        body: new Uint8Array(bytes),
        idempotencyKey: `browser-${captureKey()}`,
      };
      return await this.uploadPending();
    } finally {
      this.working = false;
    }
  }
  private async restore(bytes: Uint8Array): Promise<void> {
    if (!bytes.byteLength || bytes.byteLength > SAVE_LIMIT)
      throw new Error('State exceeds the size limit');
    await this.runtime.focus?.();
    await this.runtime.FS.writeFile(paths.save_state, new Uint8Array(bytes));
    await this.commands.run('LOAD_STATE_SLOT 0');
  }
  async loadAsset(assetId: string, legacyConfirmed = false): Promise<void> {
    this.available();
    this.working = true;
    try {
      const manifest = await this.client.manifest(this.target.itemId);
      const file = manifest.files.find((f) => f.id === assetId && f.kind === 'save_state');
      if (manifest.itemId !== this.target.itemId || !file)
        throw new Error('State does not belong to this item');
      const compatibility = this.target.core
        ? stateCompatibility(file.relativePath, this.target.core)
        : 'unknown';
      if (compatibility === 'incompatible')
        throw new Error('State belongs to a different emulator build');
      if (compatibility === 'unknown' && !legacyConfirmed)
        throw new Error('Confirm this imported state is compatible with this emulator build');
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > SAVE_LIMIT)
        throw new Error('State exceeds the size limit');
      await this.restore((await this.client.collect(file.id, { maxBytes: SAVE_LIMIT })).bytes);
      await this.runtime.focus?.();
    } finally {
      this.working = false;
    }
  }
  async loadSelectedState(): Promise<void> {
    this.available();
    this.working = true;
    try {
      if (!this.target.selectedState)
        throw new Error('No compatible state was selected before Start');
      await this.restore(this.target.selectedState);
    } finally {
      this.working = false;
    }
  }
}
