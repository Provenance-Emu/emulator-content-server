import type { Item, SystemSummary } from '@ecs/client';
import { type Readable, writable } from 'svelte/store';
import { KIND_ORDER } from './content-format.js';
export interface UploadReviewEntry {
  id: string;
  file: File;
  relativePath: string;
  title: string;
  kind: string;
  system: string;
  target: Item | null;
  errors: string[];
}
export type UploadMetadata = Partial<
  Pick<UploadReviewEntry, 'title' | 'kind' | 'system' | 'target'>
>;
export interface UploadReviewState {
  entries: UploadReviewEntry[];
  /** The first rows of the selection: fifty, and fifty more each time more is asked for. */
  visible: UploadReviewEntry[];
  hasMore: boolean;
}
export interface UploadReview extends Readable<UploadReviewState> {
  selectFiles(files: File[]): void;
  setEntryMetadata(id: string, patch: UploadMetadata): void;
  setCommonMetadata(patch: UploadMetadata): void;
  more(): void;
  validate(): UploadReviewEntry[] | null;
}
/** The path is browser-provided metadata, never a trusted local filesystem path. */
export function safeUploadPath(path: string): boolean {
  return (
    !!path &&
    path.length <= 1024 &&
    !/[\\:<>"|?*]/.test(path) &&
    !Array.from(path).some((character) => character.charCodeAt(0) < 32) &&
    path
      .split('/')
      .every(
        (part) =>
          !!part &&
          part !== '.' &&
          part !== '..' &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}
const extensionSystems: Record<string, string> = {
  nes: 'com.provenance.nes',
  gb: 'com.provenance.gb',
  gbc: 'com.provenance.gbc',
  gba: 'com.provenance.gba',
  snes: 'com.provenance.snes',
  sfc: 'com.provenance.snes',
  smc: 'com.provenance.snes',
  n64: 'com.provenance.n64',
  z64: 'com.provenance.n64',
};
export function uploadIdentity(): string {
  return `browser-upload-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
export function createUploadReview(context: {
  libraryId: string;
  item: Item | null;
  systems: SystemSummary[];
  category?: string;
}): UploadReview {
  let entries: UploadReviewEntry[] = [];
  let common: UploadMetadata = {};
  let shown = 50;
  const store = writable<UploadReviewState>({ entries, visible: [], hasMore: false });
  function publish() {
    store.set({ entries, visible: entries.slice(0, shown), hasMore: shown < entries.length });
  }
  function errors(e: UploadReviewEntry): string[] {
    const result: string[] = [];
    if (!safeUploadPath(e.relativePath))
      result.push("This file's name or folder cannot be used. Rename it, then choose it again.");
    if (!KIND_ORDER.includes(e.kind as (typeof KIND_ORDER)[number]))
      result.push('Choose what this file is.');
    if (e.target && e.target.libraryId !== context.libraryId)
      result.push('Choose a game in this library.');
    if (e.kind !== 'rom' && !e.target) result.push('Choose the game this file belongs to.');
    if (e.kind === 'rom' && !e.target) {
      if (!e.title.trim()) result.push('Give the game a name.');
      if (!context.systems.some((s) => s.identifier === e.system))
        result.push('Choose its system.');
    }
    return result;
  }
  function edit(id: string | null, patch: UploadMetadata) {
    entries = entries.map((e) => {
      if (id !== null && e.id !== id) return e;
      if (id === null && patch.target && e.kind === 'rom' && !context.item) return e;
      const edited = {
        ...e,
        ...patch,
        ...(patch.kind === 'rom' && !context.item ? { target: null } : {}),
      };
      return { ...edited, errors: errors(edited) };
    });
    publish();
  }
  return {
    subscribe: store.subscribe,
    selectFiles(files) {
      shown = 50;
      entries = files.map((file) => {
        const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
        const inferred = extensionSystems[extension] ?? '';
        const system =
          context.item?.systemIdentifier ??
          (context.systems.some((s) => s.identifier === inferred) ? inferred : '');
        // Recognized save formats keep their association requirement even in Games.
        const kind =
          extension === 'sav'
            ? 'battery_save'
            : extension === 'state'
              ? 'save_state'
              : inferred || context.category === 'games'
                ? 'rom'
                : '';
        const e = {
          id: uploadIdentity(),
          file,
          relativePath: file.webkitRelativePath || file.name,
          title: file.name.replace(/\.[^.]+$/, ''),
          kind,
          system,
          target: context.item,
          errors: [],
        };
        const edited = { ...e, ...common };
        if (edited.kind === 'rom' && !context.item) edited.target = null;
        return { ...edited, errors: errors(edited) };
      });
      publish();
    },
    setEntryMetadata(id, patch) {
      edit(id, patch);
    },
    setCommonMetadata(patch) {
      common = { ...common, ...patch };
      edit(null, patch);
    },
    more() {
      shown = Math.min(entries.length, shown + 50);
      publish();
    },
    validate() {
      entries = entries.map((e) => ({ ...e, errors: errors(e) }));
      publish();
      return entries.length && entries.every((e) => !e.errors.length) ? entries : null;
    },
  };
}
