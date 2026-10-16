import { cp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { issueToken } from '@ecs/auth';
import { CatalogDatabase, type CatalogLimits, type StorageLocationRecord } from '@ecs/database';
import {
  blobPath,
  ensureBlobStore,
  ensureLayout,
  inspectRoot,
  locationOnline,
  resolveContentRoot,
  resolveStorageLocation,
} from '@ecs/storage';

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
    const locations = catalog.listStorageLocations();
    const offline = new Set<string>();
    for (const location of locations) {
      if (await locationOnline(location.path)) {
        lines.push(`location ${location.label} online`);
      } else {
        lines.push(`offline location ${location.label}`);
        offline.add(location.id);
        ok = false;
      }
    }
    for (const blob of catalog.blobPlacements()) {
      if (blob.locationId && offline.has(blob.locationId)) continue;
      const location = blob.locationId
        ? locations.find((item) => item.id === blob.locationId)
        : undefined;
      if (blob.locationId && !location) {
        lines.push('offline location unknown');
        ok = false;
        continue;
      }
      try {
        await stat(blobPath(location?.path ?? dataDir, blob.sha256));
      } catch {
        lines.push(`missing blob ${blob.sha256}`);
        ok = false;
      }
    }
  } finally {
    catalog.close();
  }
  return { ok, lines };
}

export async function backupData(dataDir: string, destination: string): Promise<void> {
  const catalog = new CatalogDatabase(join(dataDir, 'library.sqlite'));
  try {
    const locations = catalog.listStorageLocations();
    const offline: StorageLocationRecord[] = [];
    for (const location of locations) {
      if (!(await locationOnline(location.path))) offline.push(location);
    }
    if (offline.length > 0) {
      const named = offline.map((location) => `${location.label} (${location.path})`).join(', ');
      throw new Error(`backup refused: ${named} offline`);
    }
    const existed = await stat(destination).then(
      () => true,
      () => false,
    );
    try {
      await ensureLayout(destination);
      catalog.backupTo(join(destination, 'library.sqlite'));
      await cp(join(dataDir, 'blobs'), join(destination, 'blobs'), { recursive: true });
      if (locations.length > 0) await copyLocations(destination, locations);
    } catch (error) {
      if (!existed) await rm(destination, { recursive: true, force: true });
      throw error;
    }
  } finally {
    catalog.close();
  }
}

async function copyLocations(
  destination: string,
  locations: readonly StorageLocationRecord[],
): Promise<void> {
  await writeFile(
    join(destination, 'locations.json'),
    `${JSON.stringify(
      locations.map((location) => ({
        id: location.id,
        label: location.label,
        path: location.path,
      })),
      null,
      2,
    )}\n`,
  );
  for (const location of locations) {
    await cp(join(location.path, 'blobs'), join(destination, 'locations', location.id, 'blobs'), {
      recursive: true,
    });
  }
}

/**
 * Local changes are attributed to `cli` rather than to the owner account,
 * because whoever can read the data directory ran them and the audit log should
 * say so. It also works before bootstrap, when no owner exists yet.
 */
const CLI_ACTOR = 'cli';

export function listRoots(dataDir: string) {
  return withCatalog(dataDir, (catalog) => catalog.listContentRoots());
}

export async function addRoot(
  dataDir: string,
  input: { path: string; label: string; libraryId: string | null },
) {
  const saved = withCatalog(dataDir, (catalog) => catalog.listContentRoots());
  const path = await resolveContentRoot(
    dataDir,
    input.path,
    saved.map((root) => root.path),
  );
  return withCatalog(dataDir, (catalog) => {
    if (input.libraryId !== null && !catalog.getLibrary(input.libraryId)) {
      throw new Error('Library not found');
    }
    return catalog.createContentRoot({
      path,
      label: input.label,
      libraryId: input.libraryId,
      actorId: CLI_ACTOR,
    });
  });
}

export function removeRoot(dataDir: string, id: string): void {
  withCatalog(dataDir, (catalog) => catalog.deleteContentRoot(id, CLI_ACTOR));
}

export function listLocations(dataDir: string): {
  locations: StorageLocationRecord[];
  writeLocationId: string | null;
} {
  return withCatalog(dataDir, (catalog) => ({
    locations: catalog.listStorageLocations(),
    writeLocationId: catalog.writeLocation()?.id ?? null,
  }));
}

export async function addLocation(
  dataDir: string,
  input: { path: string; label: string },
): Promise<StorageLocationRecord> {
  const saved = withCatalog(dataDir, (catalog) => ({
    locations: catalog.listStorageLocations(),
    roots: catalog.listContentRoots(),
  }));
  const path = await resolveStorageLocation(
    dataDir,
    input.path,
    saved.locations.map((location) => location.path),
    saved.roots.map((root) => root.path),
  );
  await ensureBlobStore(path);
  return withCatalog(dataDir, (catalog) =>
    catalog.createStorageLocation({ path, label: input.label, actorId: CLI_ACTOR }),
  );
}

export function useLocation(dataDir: string, id: string | null): void {
  withCatalog(dataDir, (catalog) => {
    catalog.ensureServer('Emulator Content Server');
    catalog.setWriteLocation(id, CLI_ACTOR);
  });
}

export function removeLocation(dataDir: string, id: string): void {
  withCatalog(dataDir, (catalog) => catalog.deleteStorageLocation(id, CLI_ACTOR));
}

export async function scanRoots(
  dataDir: string,
  rootId: string | null,
): Promise<Array<{ label: string; medium: string; online: boolean; count: number }>> {
  const catalog = new CatalogDatabase(join(dataDir, 'library.sqlite'));
  try {
    const roots = catalog
      .listContentRoots()
      .filter((root) => rootId === null || root.id === rootId);
    if (rootId !== null && roots.length === 0) throw new Error('Content root not found');
    const results = [];
    for (const root of roots) {
      const inspected = await inspectRoot(root.path);
      const count = catalog.applyInspection({
        rootId: root.id,
        actorId: CLI_ACTOR,
        online: inspected.online,
        files: inspected.files,
      });
      results.push({
        label: root.label,
        medium: inspected.medium,
        online: inspected.online,
        count,
      });
    }
    return results;
  } finally {
    catalog.close();
  }
}

function withCatalog<T>(dataDir: string, use: (catalog: CatalogDatabase) => T): T {
  const catalog = new CatalogDatabase(join(dataDir, 'library.sqlite'));
  try {
    return use(catalog);
  } finally {
    catalog.close();
  }
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
