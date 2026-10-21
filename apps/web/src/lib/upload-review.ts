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
  visible: UploadReviewEntry[];
  page: number;
  pages: number;
}
export interface UploadReview extends Readable<UploadReviewState> {
  selectFiles(files: File[]): void;
  setEntryMetadata(id: string, patch: UploadMetadata): void;
  setCommonMetadata(patch: UploadMetadata): void;
  page(index: number): void;
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
  let index = 0;
  const store = writable<UploadReviewState>({ entries, visible: [], page: 0, pages: 1 });
  function publish() {
    const pages = Math.max(1, Math.ceil(entries.length / 50));
    index = Math.max(0, Math.min(index, pages - 1));
    store.set({ entries, visible: entries.slice(index * 50, index * 50 + 50), page: index, pages });
  }
  function errors(e: UploadReviewEntry): string[] {
    const result: string[] = [];
    if (!safeUploadPath(e.relativePath))
      result.push('Unsafe relative path. Select this file again with a safe name.');
    if (!KIND_ORDER.includes(e.kind as (typeof KIND_ORDER)[number])) result.push('Choose a kind.');
    if (e.target && e.target.libraryId !== context.libraryId)
      result.push('Choose an item in this library.');
    if (e.kind !== 'rom' && !e.target) result.push('Choose an existing managed item.');
    if (e.kind === 'rom' && !e.target) {
      if (!e.title.trim()) result.push('Enter a title.');
      if (!context.systems.some((s) => s.identifier === e.system)) result.push('Choose a system.');
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
      index = 0;
      entries = files.map((file) => {
        const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
        const inferred = extensionSystems[extension] ?? '';
        const system =
          context.item?.systemIdentifier ??
          (context.systems.some((s) => s.identifier === inferred) ? inferred : '');
        const kind =
          context.category === 'games'
            ? 'rom'
            : inferred
              ? 'rom'
              : extension === 'sav'
                ? 'battery_save'
                : extension === 'state'
                  ? 'save_state'
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
    page(page) {
      index = page;
      publish();
    },
    validate() {
      entries = entries.map((e) => ({ ...e, errors: errors(e) }));
      publish();
      return entries.length && entries.every((e) => !e.errors.length) ? entries : null;
    },
  };
}
