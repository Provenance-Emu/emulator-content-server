import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type LoadedWorkflowPlugin,
  loadWorkflowPlugin,
  parseWorkflowPackage,
  WORKFLOW_PACKAGE_LIMITS,
} from '@ecs/plugins/workflows';

export interface InstalledWorkflowPackage extends LoadedWorkflowPlugin {
  digest: string;
}
interface Activation {
  activeDigest: string | null;
  disabled: boolean;
}

function identifier(id: string): string {
  if (!/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(id) || id.length > 200)
    throw new Error('Invalid workflow package ID');
  return id;
}
function digestValue(digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid workflow package digest');
  return digest;
}
async function activation(state: string, id: string): Promise<Activation> {
  const path = join(state, 'activations', `${identifier(id)}.json`);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { activeDigest: null, disabled: false };
    throw error;
  }
  if (bytes.length > 64 * 1024) throw new Error('Invalid activation state');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid activation state');
  const record = value as Activation;
  if (
    typeof record.disabled !== 'boolean' ||
    (record.activeDigest !== null &&
      (typeof record.activeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.activeDigest)))
  )
    throw new Error('Invalid activation state');
  return record;
}
async function publishActivation(state: string, id: string, value: Activation): Promise<void> {
  const directory = join(state, 'activations');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.pending-${randomUUID()}`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, `${identifier(id)}.json`));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function installWorkflowPackage(
  stateDir: string,
  bytes: Uint8Array,
): Promise<InstalledWorkflowPackage> {
  const bundle = parseWorkflowPackage(bytes);
  const parent = join(stateDir, 'packages', bundle.manifest.id);
  const directory = join(parent, bundle.digest);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const [name, content] of bundle.files) {
      const target = join(staging, ...name.split('/'));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: 'wx', mode: 0o600 });
    }
    await writeFile(join(staging, 'plugin.json'), JSON.stringify(bundle.manifest), {
      flag: 'wx',
      mode: 0o600,
    });
    await loadWorkflowPlugin(staging);
    try {
      await rename(staging, directory);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
      // An identical content-addressed installation is already present.
      await loadWorkflowPlugin(directory);
    }
    return { ...(await loadWorkflowPlugin(directory)), digest: bundle.digest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function activateWorkflowPackage(
  state: string,
  id: string,
  digest: string,
): Promise<void> {
  const directory = join(state, 'packages', identifier(id), digestValue(digest));
  const installed = await loadWorkflowPlugin(directory);
  if (installed.manifest.id !== id) throw new Error('Workflow identity mismatch');
  // Independent receipts cannot lose a pinned version when two owner activations race.
  const grants = join(state, 'activation-grants', identifier(id));
  await mkdir(grants, { recursive: true, mode: 0o700 });
  await writeFile(join(grants, digest), digest, { mode: 0o600 });
  await publishActivation(state, id, { activeDigest: digest, disabled: false });
}

export async function disableWorkflowPackage(state: string, id: string): Promise<void> {
  const current = await activation(state, identifier(id));
  await publishActivation(state, id, { ...current, disabled: true });
}

export async function resolveWorkflowPackage(
  state: string,
  id: string,
  pinned?: string,
): Promise<InstalledWorkflowPackage> {
  const current = await activation(state, identifier(id));
  const digest = pinned ? digestValue(pinned) : current.activeDigest;
  if (!digest || current.disabled)
    throw new Error('Workflow package is not activated or is disabled');
  let granted = false;
  try {
    granted = (await readFile(join(state, 'activation-grants', id, digest), 'utf8')) === digest;
  } catch {
    /* An installed package is not automatically authorized. */
  }
  if (!granted) throw new Error('Workflow package has not been activated');
  const plugin = await loadWorkflowPlugin(join(state, 'packages', id, digest));
  if (plugin.manifest.id !== id) throw new Error('Workflow identity mismatch');
  return { ...plugin, digest };
}

export async function listWorkflowPackages(state: string): Promise<InstalledWorkflowPackage[]> {
  const directory = join(state, 'packages');
  const result: InstalledWorkflowPackage[] = [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  for (const name of names.sort()) {
    identifier(name);
    for (const digest of (await readdir(join(directory, name))).sort()) {
      if (digest.startsWith('.staging-')) continue;
      digestValue(digest);
      result.push({ ...(await loadWorkflowPlugin(join(directory, name, digest))), digest });
    }
  }
  return result;
}

export async function readWorkflowBundle(path: string): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    if ((await file.stat()).size > WORKFLOW_PACKAGE_LIMITS.bytes)
      throw new Error('Workflow package exceeds size limit');
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const bytes of file.createReadStream({
      autoClose: false,
      highWaterMark: 64 * 1024,
    })) {
      const chunk = Buffer.from(bytes);
      length += chunk.length;
      if (length > WORKFLOW_PACKAGE_LIMITS.bytes)
        throw new Error('Workflow package exceeds size limit');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    await file.close();
  }
}

export async function snapshotWorkflowDirectory(directory: string): Promise<Buffer> {
  const loaded = await loadWorkflowPlugin(directory);
  const entries: { name: string; size: number; sha256: string }[] = [];
  const contents: Buffer[] = [];
  let total = 0;
  async function visit(current: string, prefix: string): Promise<void> {
    for (const item of (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const name = prefix ? `${prefix}/${item.name}` : item.name;
      const path = join(current, item.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Workflow directory cannot contain symlinks');
      if (info.isDirectory()) {
        await visit(path, name);
        continue;
      }
      if (!info.isFile()) throw new Error('Workflow package accepts only ordinary files');
      if (name === 'plugin.json') continue;
      if (
        entries.length >= WORKFLOW_PACKAGE_LIMITS.files ||
        info.size > WORKFLOW_PACKAGE_LIMITS.fileBytes
      )
        throw new Error('Workflow directory exceeds package limits');
      const bytes = await readWorkflowBundle(path);
      total += bytes.length;
      if (bytes.length > WORKFLOW_PACKAGE_LIMITS.fileBytes || total > WORKFLOW_PACKAGE_LIMITS.bytes)
        throw new Error('Workflow directory exceeds package limits');
      entries.push({
        name,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      contents.push(bytes);
    }
  }
  await visit(loaded.directory, '');
  const header = Buffer.from(JSON.stringify({ manifest: loaded.manifest, files: entries }));
  if (
    header.length > WORKFLOW_PACKAGE_LIMITS.header ||
    total + header.length + 4 > WORKFLOW_PACKAGE_LIMITS.bytes
  )
    throw new Error('Workflow directory exceeds package limits');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const bundle = Buffer.concat([length, header, ...contents]);
  parseWorkflowPackage(bundle);
  return bundle;
}

export async function activeWorkflowPackages(state: string) {
  const ids = [...new Set((await listWorkflowPackages(state)).map((p) => p.manifest.id))];
  const packages: import('@ecs/protocol').WorkflowPackageSummary[] = [];
  for (const id of ids) {
    const current = await activation(state, id);
    if (current.disabled || !current.activeDigest) continue;
    const p = await resolveWorkflowPackage(state, id);
    packages.push({
      id,
      name: p.manifest.name,
      version: p.manifest.version,
      digest: p.digest,
      kind: p.manifest.kind,
    });
  }
  return packages;
}
