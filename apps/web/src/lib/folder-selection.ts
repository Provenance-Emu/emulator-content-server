/** Native implementation belongs to apps/tray; browsers use server-directory browsing. */
export type FolderPurpose = 'library-folder' | 'upload-storage';

export interface FolderSelection {
  path: string;
  suggestedName: string;
  origin: string;
  contextKey: string;
  verificationId?: string;
}

export interface FolderSelectionAdapter {
  choose(request: { contextKey: string; purpose: FolderPurpose }): Promise<FolderSelection | null>;
  validate(selection: FolderSelection): Promise<boolean>;
}

export interface FolderContext {
  key: string;
  origin: string;
  folderSelection?: FolderSelectionAdapter;
  isCurrent?: () => boolean;
  onrejected?: (status: 401 | 403) => void;
  onchanged?: () => void | Promise<void>;
}

export function folderName(path: string): string {
  return path.trim().split(/[/\\]/).filter(Boolean).at(-1) || 'Server folder';
}
export function matchesFolderContext(selection: FolderSelection, context: FolderContext): boolean {
  return (
    selection.contextKey === context.key &&
    selection.origin === context.origin &&
    !!selection.path.trim() &&
    (context.isCurrent?.() ?? true)
  );
}
export async function validateFolderSelection(
  selection: FolderSelection,
  context: FolderContext,
): Promise<boolean> {
  if (!matchesFolderContext(selection, context)) return false;
  if (context.folderSelection && !(await context.folderSelection.validate(selection))) return false;
  return matchesFolderContext(selection, context);
}
export async function chooseFolder(
  context: FolderContext,
  purpose: FolderPurpose,
): Promise<FolderSelection | null> {
  const key = context.key;
  if (!context.folderSelection || !(context.isCurrent?.() ?? true)) return null;
  const selected = await context.folderSelection.choose({ contextKey: key, purpose });
  if (!selected || context.key !== key || !(await validateFolderSelection(selected, context)))
    return null;
  return selected;
}
