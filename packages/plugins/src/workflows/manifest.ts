import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import semver from 'semver';
import { pluginFile, safeRelativePath } from '../paths.js';
import { type CapabilityBinding, parseCapabilityBinding } from './capabilities.js';
import { type SchemaDocument, validateSchemaDocument } from './schemas.js';
import {
  integer,
  invalid,
  jsonValue,
  list,
  object,
  text,
  unique,
  WORKFLOW_LIMITS,
} from './values.js';

export const WORKFLOW_ENGINE = 'ecs.plugin/2';
export const WORKFLOW_HOST_API = '1.0.0';
export type WorkflowEffect =
  | 'library.read'
  | 'proposal.create'
  | 'external.read'
  | 'external.mutate'
  | 'external.paid';
export interface WorkflowManifestV2 {
  id: string;
  name: string;
  version: string;
  engine: typeof WORKFLOW_ENGINE;
  hostApi: string;
  kind: 'workflow' | 'translator' | 'tool';
  entry: string;
  configurationSchema?: string;
  inputSchema?: string;
  outputSchema?: string;
  bindings?: Record<string, CapabilityBinding>;
  provides?: CapabilityBinding[];
  credentials?: string[];
  effects?: WorkflowEffect[];
  destinations?: string[];
}
export interface LoadedWorkflowPlugin {
  directory: string;
  manifest: WorkflowManifestV2;
  schemas: Record<string, SchemaDocument>;
}

export function parseWorkflowManifest(value: unknown): WorkflowManifestV2 {
  jsonValue(value, WORKFLOW_LIMITS.manifest, true);
  const record = object(value, [
    'id',
    'name',
    'version',
    'engine',
    'hostApi',
    'kind',
    'entry',
    'configurationSchema',
    'inputSchema',
    'outputSchema',
    'bindings',
    'provides',
    'credentials',
    'effects',
    'destinations',
  ]);
  const id = text(record.id, 200),
    version = text(record.version, 40),
    hostApi = text(record.hostApi, 80);
  if (
    !/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(id) ||
    !semver.valid(version) ||
    !semver.validRange(hostApi) ||
    !semver.satisfies(WORKFLOW_HOST_API, hostApi)
  )
    invalid('Incompatible workflow identity or version');
  if (
    record.engine !== WORKFLOW_ENGINE ||
    !['workflow', 'translator', 'tool'].includes(String(record.kind))
  )
    invalid('Unsupported workflow engine or kind');
  if (text(record.entry).includes('\\')) invalid('Workflow paths use forward slashes');
  const entry = safeRelativePath(text(record.entry));
  if (!entry.endsWith('.mjs') || entry.includes('\\'))
    invalid('Workflow entry must be a relative .mjs module');
  const manifest: WorkflowManifestV2 = {
    id,
    name: text(record.name, 80),
    version,
    hostApi,
    engine: WORKFLOW_ENGINE,
    kind: record.kind as WorkflowManifestV2['kind'],
    entry,
  };
  for (const key of ['configurationSchema', 'inputSchema', 'outputSchema'] as const) {
    if (record[key] !== undefined) {
      if (text(record[key]).includes('\\')) invalid('Workflow paths use forward slashes');
      const path = safeRelativePath(text(record[key]));
      if (!path.endsWith('.json')) invalid('Workflow schemas must be JSON files');
      manifest[key] = path;
    }
  }
  if (record.effects !== undefined) {
    const effects = list(record.effects, 5).map((effect) => text(effect));
    if (
      effects.some(
        (effect) =>
          ![
            'library.read',
            'proposal.create',
            'external.read',
            'external.mutate',
            'external.paid',
          ].includes(effect),
      )
    )
      invalid('Unsupported workflow effect');
    unique(effects);
    manifest.effects = effects as WorkflowEffect[];
  }
  if (manifest.kind === 'workflow') {
    if (
      !manifest.inputSchema ||
      !manifest.outputSchema ||
      record.provides !== undefined ||
      record.credentials !== undefined
    )
      invalid('Invalid workflow declarations');
    const bindings = object(record.bindings);
    if (Object.keys(bindings).length > 32) invalid('Too many workflow bindings');
    manifest.bindings = {};
    for (const [role, binding] of Object.entries(bindings)) {
      if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(role)) invalid('Invalid workflow role');
      manifest.bindings[role] = parseCapabilityBinding(binding);
    }
  } else {
    if (record.bindings !== undefined) invalid('Only workflows declare bindings');
    manifest.provides = list(record.provides, 32).map(parseCapabilityBinding);
    if (manifest.provides.length === 0) invalid('A plugin must provide a capability');
    unique(manifest.provides.map((provided) => `${provided.capability}@${provided.major}`));
    if (record.credentials !== undefined) {
      manifest.credentials = list(record.credentials, 8).map((name) => {
        const field = text(name, 64);
        if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(field)) invalid('Invalid credential name');
        return field;
      });
      unique(manifest.credentials);
    }
  }
  if (record.destinations !== undefined) {
    manifest.destinations = list(record.destinations, 32).map((value) => {
      const url = new URL(text(value, 2048));
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
      )
        invalid('Destinations must be credential-free origins');
      return url.origin;
    });
    unique(manifest.destinations);
  }
  return manifest;
}

/** Discovery validates files and schemas; it never imports executable entries. */
export async function loadWorkflowPlugin(directory: string): Promise<LoadedWorkflowPlugin> {
  const root = await realpath(directory);
  async function containedFile(name: string, maximum: number): Promise<Buffer> {
    const target = pluginFile(root, name);
    const relativePath = relative(root, await realpath(target));
    if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`))
      invalid('Workflow path escapes its package');
    // Disallow symlinks even if their current target happens to be inside the package.
    let path = root;
    for (const part of name.split('/')) {
      path = resolve(path, part);
      if ((await lstat(path)).isSymbolicLink()) invalid('Workflow symlinks are forbidden');
    }
    const info = await lstat(target);
    if (!info.isFile()) invalid('Workflow file must be a regular file');
    integer(info.size, 1, maximum);
    const bytes = await readFile(target);
    integer(bytes.length, 1, maximum);
    return bytes;
  }
  const manifest = parseWorkflowManifest(
    JSON.parse((await containedFile('plugin.json', WORKFLOW_LIMITS.manifest)).toString('utf8')),
  );
  await containedFile(manifest.entry, 16 * 1024 * 1024);
  const schemas: Record<string, SchemaDocument> = {};
  for (const path of new Set(
    [manifest.configurationSchema, manifest.inputSchema, manifest.outputSchema].filter(
      (path): path is string => !!path,
    ),
  )) {
    schemas[path] = validateSchemaDocument(
      JSON.parse((await containedFile(path, WORKFLOW_LIMITS.schema)).toString('utf8')),
    );
  }
  return { directory: root, manifest, schemas };
}
