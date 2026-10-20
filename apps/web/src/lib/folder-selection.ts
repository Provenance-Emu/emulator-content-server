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
