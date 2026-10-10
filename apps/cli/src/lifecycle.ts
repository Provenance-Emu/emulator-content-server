import { cp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { issueToken } from '@ecs/auth';
import { CatalogDatabase, type CatalogLimits } from '@ecs/database';
import { blobPath, ensureLayout } from '@ecs/storage';

export interface InitResult {
  dataDir: string;
  bootstrapped: boolean;
  token: string | null;
  tokenFile: string;
}

export async function initData(dataDir: string, displayName: string): Promise<InitResult> {
  await ensureLayout(dataDir);
  const catalog = new CatalogDatabase(join(dataDir, 'library.sqlite'));
  try {
    catalog.ensureServer(displayName);
    const state = catalog.server();
    const tokenFile = join(dataDir, 'bootstrap.token');
    if (state.bootstrapped) return { dataDir, bootstrapped: true, token: null, tokenFile };
    let token: string | null = null;
    let fileExists = false;
    try {
      await stat(tokenFile);
      fileExists = true;
    } catch {
      fileExists = false;
    }
    if (!catalog.hasBootstrapToken() || !fileExists) {
      const issued = issueToken();
      catalog.saveBootstrapHash(issued.hash);
      await writeFile(tokenFile, `${issued.token}\n`, { mode: 0o600 });
      token = issued.token;
    }
    return { dataDir, bootstrapped: false, token, tokenFile };
  } finally {
    catalog.close();
  }
}

export async function doctor(dataDir: string): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const databasePath = join(dataDir, 'library.sqlite');
  try {
    await stat(databasePath);
  } catch {
    return { ok: false, lines: ['database missing'] };
  }
  const catalog = new CatalogDatabase(databasePath);
  try {
    const integrity = catalog.integrity();
    lines.push(`integrity ${integrity}`);
    if (integrity !== 'ok') ok = false;
    const state = catalog.ensureServer('Emulator Content Server');
    lines.push(`server ${state.serverId}`);
    lines.push(state.bootstrapped ? 'bootstrap complete' : 'bootstrap pending');
    if (!state.bootstrapped) {
      try {
        await stat(join(dataDir, 'bootstrap.token'));
        lines.push('bootstrap token file present');
      } catch {
        lines.push('bootstrap token file missing');
        ok = false;
      }
    }
    for (const hash of catalog.blobHashes()) {
      try {
        await stat(blobPath(dataDir, hash));
      } catch {
        lines.push(`missing blob ${hash}`);
        ok = false;
      }
    }
  } finally {
    catalog.close();
  }
  return { ok, lines };
}

export async function backupData(dataDir: string, destination: string): Promise<void> {
  await ensureLayout(destination);
  const catalog = new CatalogDatabase(join(dataDir, 'library.sqlite'));
  try {
    catalog.backupTo(join(destination, 'library.sqlite'));
  } finally {
    catalog.close();
  }
  await cp(join(dataDir, 'blobs'), join(destination, 'blobs'), { recursive: true });
}

export function limitsFromEnv(env: NodeJS.ProcessEnv): Partial<CatalogLimits> {
  const limits: Partial<CatalogLimits> = {};
  const maxUploadBytes = envNumber(env.ECS_MAX_UPLOAD_BYTES);
  const maxLibraryBytes = envNumber(env.ECS_MAX_LIBRARY_BYTES);
  if (maxUploadBytes !== undefined) limits.maxUploadBytes = maxUploadBytes;
  if (maxLibraryBytes !== undefined) limits.maxLibraryBytes = maxLibraryBytes;
  return limits;
}

function envNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('Quota environment values must be positive integers');
  }
  return parsed;
}

export async function removeBootstrapFile(dataDir: string): Promise<void> {
  await rm(join(dataDir, 'bootstrap.token'), { force: true });
}
