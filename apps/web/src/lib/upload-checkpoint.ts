import type { Item } from '@ecs/client';
import { KIND_ORDER } from './content-format.js';
import { safeUploadPath } from './upload-review.js';

export interface SavedUploadEntry {
  id: string;
  name: string;
  size: number;
  sha256: string;
  relativePath: string;
  title: string;
  kind: string;
  system: string;
  target: Item | null;
  phase:
    | 'waiting'
    | 'creating'
    | 'transferring'
    | 'succeeded'
    | 'failed'
    | 'reconciliation-required';
  sent: number;
  idempotencyKey: string;
  baseRevision: number | null;
}
export interface UploadCheckpoint {
  version: 1;
  libraryId: string;
  itemId: string | null;
  entries: SavedUploadEntry[];
  touched: string[];
}
export interface UploadCheckpointRecord {
  revision: number;
  snapshot: UploadCheckpoint;
}
export interface UploadJournal {
  read(): Promise<UploadCheckpointRecord | null>;
  save(snapshot: UploadCheckpoint, expectedRevision: number | null): Promise<number>;
  remove(expectedRevision: number): Promise<void>;
  discard?(): Promise<void>;
}
export const MAX_SAVED_UPLOADS = 1000;
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** Restore only known metadata fields. Never accept a serialized File, request body or credential. */
export function parseUploadCheckpoint(
  value: unknown,
  libraryId: string,
  itemId: string | null,
): UploadCheckpoint {
  if (
    !record(value) ||
    value.version !== 1 ||
    value.libraryId !== libraryId ||
    value.itemId !== itemId ||
    !Array.isArray(value.entries) ||
    !value.entries.length ||
    value.entries.length > MAX_SAVED_UPLOADS ||
    !Array.isArray(value.touched) ||
    value.touched.length > MAX_SAVED_UPLOADS ||
    !value.touched.every((id) => text(id, 256))
  )
    throw new Error('Saved upload progress is invalid. Discard it to start a new queue.');
  const ids = new Set<string>();
  const keys = new Set<string>();
  const entries = value.entries.map((raw): SavedUploadEntry => {
    if (
      !record(raw) ||
      !text(raw.id, 256) ||
      !raw.id ||
      ids.has(raw.id) ||
      !text(raw.name, 1024) ||
      !raw.name ||
      !integer(raw.size) ||
      typeof raw.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(raw.sha256) ||
      !text(raw.relativePath, 1024) ||
      !safeUploadPath(raw.relativePath) ||
      !text(raw.title, 1024) ||
      !text(raw.system, 256) ||
      typeof raw.kind !== 'string' ||
      !KIND_ORDER.includes(raw.kind as (typeof KIND_ORDER)[number]) ||
      typeof raw.phase !== 'string' ||
      ![
        'waiting',
        'creating',
        'transferring',
        'succeeded',
        'failed',
        'reconciliation-required',
      ].includes(raw.phase) ||
      !integer(raw.sent) ||
      raw.sent > raw.size ||
      !text(raw.idempotencyKey, 256) ||
      !raw.idempotencyKey ||
      keys.has(raw.idempotencyKey) ||
      !(raw.baseRevision === null || (integer(raw.baseRevision) && raw.baseRevision > 0))
    )
      throw new Error('Saved upload progress is invalid. Discard it to start a new queue.');
    let target: Item | null = null;
    if (raw.target !== null) {
      const t = raw.target;
      if (
        !record(t) ||
        !text(t.id, 256) ||
        !t.id ||
        t.libraryId !== libraryId ||
        (itemId !== null && t.id !== itemId) ||
        !integer(t.revision) ||
        !t.revision ||
        !text(t.title, 1024) ||
        !text(t.systemIdentifier, 256)
      )
        throw new Error('Saved upload target is invalid. Discard it to start a new queue.');
      target = {
        id: t.id,
        libraryId,
        revision: t.revision,
        title: t.title,
        systemIdentifier: t.systemIdentifier,
        md5: null,
        crc: null,
        createdAt: '',
        updatedAt: '',
      };
    }
    if ((raw.baseRevision !== null && !target) || (raw.kind !== 'rom' && !target))
      throw new Error('Saved upload target is missing.');
    ids.add(raw.id);
    keys.add(raw.idempotencyKey);
    return {
      id: raw.id,
      name: raw.name,
      size: raw.size,
      sha256: raw.sha256,
      relativePath: raw.relativePath,
      title: raw.title,
      kind: raw.kind,
      system: raw.system,
      target,
      phase: raw.phase as SavedUploadEntry['phase'],
      sent: raw.sent,
      idempotencyKey: raw.idempotencyKey,
      baseRevision: raw.baseRevision,
    };
  });
  return { version: 1, libraryId, itemId, entries, touched: [...value.touched] as string[] };
}
