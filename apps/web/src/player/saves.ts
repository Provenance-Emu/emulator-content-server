import type { Asset, UploadRequest } from '@ecs/client';
import type { CommandChannel } from './commands.js';
import type { PlayerClient } from './controller.js';
import { SAVE_LIMIT } from './preflight.js';
import { type PlayerRuntime, paths } from './runtime.js';
export type SaveKind = 'battery_save' | 'save_state';
export interface SaveTarget {
  libraryId: string;
  itemId: string;
  revision: number;
  batteryPath?: string;
  statePath?: string;
  selectedState?: Uint8Array<ArrayBuffer>;
}
type CapturedSave = Omit<UploadRequest, 'body' | 'kind'> & {
  kind: SaveKind;
  body: Uint8Array<ArrayBuffer>;
};

/** The gameplay baseline belongs to the bytes loaded at start, never a polled manifest. */
export class SaveSynchronizer {
  private request: CapturedSave | null = null;
  private working = false;
  private baseline: number;
  lastConflict: Asset | null = null;
  constructor(
    private readonly client: Pick<PlayerClient, 'upload'>,
    private readonly runtime: PlayerRuntime,
    private readonly commands: CommandChannel,
    private readonly target: SaveTarget,
  ) {
    this.baseline = target.revision;
  }

  get busy(): boolean {
    return this.working;
  }
  get pending(): {
    kind: SaveKind;
    relativePath: string;
    baseRevision: number;
    size: number;
  } | null {
    const request = this.request;
    return request
      ? {
          kind: request.kind,
          relativePath: request.relativePath,
          baseRevision: request.baseRevision,
          size: request.body.byteLength,
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
    try {
      await this.commands.run(kind === 'battery_save' ? 'SAVE_FILES' : 'SAVE_STATE_SLOT 0');
      // Only the exact completed acknowledgement permits reading the expected file.
      const file = this.runtime.FS.readFile(paths[kind]);
      if (!(file instanceof Uint8Array) || file.byteLength <= 0 || file.byteLength > SAVE_LIMIT)
        throw new Error('Completed save is missing or exceeds the save size limit');
      const body = new Uint8Array(file);
      const relativePath =
        (kind === 'battery_save' ? this.target.batteryPath : this.target.statePath) ??
        `browser-fceumm/game.${kind === 'battery_save' ? 'srm' : 'state'}`;
      this.request = {
        libraryId: this.target.libraryId,
        itemId: this.target.itemId,
        kind,
        displayName:
          kind === 'save_state'
            ? 'FCEUmm ac0d00a7 / RetroArch 4d4bfc0f slot 0'
            : 'FCEUmm battery save',
        relativePath,
        baseRevision: this.baseline,
        body,
        idempotencyKey: crypto.randomUUID(),
      };
      return await this.uploadPending();
    } finally {
      this.working = false;
    }
  }
  async retry(): Promise<Asset> {
    if (this.working) throw new Error('A save operation is already in progress');
    if (!this.request) throw new Error('No pending save');
    this.working = true;
    try {
      return await this.uploadPending();
    } finally {
      this.working = false;
    }
  }
  private async uploadPending(): Promise<Asset> {
    const request = this.request;
    if (!request) throw new Error('No pending save');
    const asset = await this.client.upload(request);
    this.lastConflict = asset.conflictOf ? asset : null;
    // Asset.revision is an asset revision, not the current item revision. A remote
    // write may already exist: advance by at most our one non-conflicting commit.
    if (!asset.conflictOf) this.baseline += 1;
    this.request = null;
    return asset;
  }
  async loadSelectedState(): Promise<void> {
    this.available();
    if (!this.target.selectedState)
      throw new Error('No compatible state was selected before Start');
    this.working = true;
    try {
      this.runtime.FS.writeFile(paths.save_state, this.target.selectedState);
      await this.commands.run('LOAD_STATE_SLOT 0');
    } finally {
      this.working = false;
    }
  }
}
