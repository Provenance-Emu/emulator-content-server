import { isAbsolute } from 'node:path';
import { PluginError } from './errors.js';
import type { FeedDraft } from './feed.js';
import { parseFeed } from './feed.js';
import { type AssetKindName, isAssetKind, type KindRule } from './kinds.js';
import { httpsUrl } from './paths.js';

export { assertClaims, claims } from './claims.js';

export const PLUGIN_ENGINE = 'ecs.plugin/1';

export const PLUGIN_KINDS = ['connector', 'player', 'feed', 'signer', 'jit'] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

export const CONNECTOR_SCHEMES = [
  'local',
  'nfs',
  'smb',
  'afp',
  'icloud',
  's3',
  'googledrive',
  'dropbox',
  'box',
  'custom',
] as const;
export type ConnectorScheme = (typeof CONNECTOR_SCHEMES)[number];

export const MOUNT_SCHEMES: ReadonlySet<ConnectorScheme> = new Set([
  'local',
  'nfs',
  'smb',
  'afp',
  'icloud',
]);

export const HTTP_SCHEMES: ReadonlySet<ConnectorScheme> = new Set([
  's3',
  'googledrive',
  'dropbox',
  'box',
]);

const PLUGIN_ID = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/;
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const SYSTEM_ID = /^[A-Za-z0-9]+(?:\.[A-Za-z0-9_-]+)+$/;
const SECRET_KEYS = new Set([
  'accesstoken',
  'secretaccesskey',
  'accesskeyid',
  'sessiontoken',
  'password',
  'refreshtoken',
  'privatekey',
  'certificatepassword',
]);

export interface ConnectorConfig {
  scheme: ConnectorScheme;
  root?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  endpoint?: string;
  folderId?: string;
  ignoreHidden: boolean;
  kinds: KindRule[];
}

export interface PlayerConfig {
  systems: string[];
  module: string;
}

export interface SignerConfig {
  tool: 'zsign';
  certificate: string;
  profile: string;
}

export interface JitConfig {
  tool: 'pymobiledevice3';
}

export interface PluginManifest {
  id: string;
  name: string;
  kind: PluginKind;
  version: string;
  engine: typeof PLUGIN_ENGINE;
  apps: string[];
  entry?: string;
  connector?: ConnectorConfig;
  player?: PlayerConfig;
  feed?: FeedDraft;
  signer?: SignerConfig;
  jit?: JitConfig;
}

export function parseManifest(value: unknown): PluginManifest {
  const record = object(value, 'plugin');
  assertNoSecrets(record, 'plugin');
  requireKeys(record, ['id', 'name', 'kind', 'version', 'engine'], 'plugin');
  const kind = oneOf(stringField(record, 'kind'), PLUGIN_KINDS, 'kind');
  const allowed = ['id', 'name', 'kind', 'version', 'engine', 'apps', 'entry', kind];
  rejectUnknown(record, allowed, 'plugin');
  const id = identifier(stringField(record, 'id'), 'Plugin id');
  const apps = record.apps === undefined ? [] : bundleList(record.apps);
  const entry = record.entry === undefined ? undefined : relativeFile(stringField(record, 'entry'));
  if (entry !== undefined && !/\.(mjs|js)$/.test(entry)) {
    throw new PluginError('invalid-manifest', 'A plugin entry must be a .js or .mjs file');
  }
  const manifest: PluginManifest = {
    id,
    name: shortText(stringField(record, 'name'), 'name', 80),
    kind,
    version: shortText(stringField(record, 'version'), 'version', 32),
    engine: PLUGIN_ENGINE,
    apps,
  };
  if (stringField(record, 'engine') !== PLUGIN_ENGINE) {
    throw new PluginError('invalid-manifest', `engine must be ${PLUGIN_ENGINE}`);
  }
  if (entry !== undefined) manifest.entry = entry;
  if (kind === 'connector') manifest.connector = parseConnector(record.connector, entry);
  if (kind === 'player') manifest.player = parsePlayer(record.player);
  if (kind === 'feed') manifest.feed = parseFeed(record.feed, apps);
  if (kind === 'signer') manifest.signer = parseSigner(record.signer);
  if (kind === 'jit') manifest.jit = parseJit(record.jit);
  if (kind !== 'connector' && apps.length === 0) {
    throw new PluginError('invalid-manifest', `${kind} plugins must list the apps they serve`);
  }
  return manifest;
}

function parseConnector(value: unknown, entry: string | undefined): ConnectorConfig {
  const record = object(value, 'connector');
  requireKeys(record, ['scheme'], 'connector');
  const scheme = oneOf(stringField(record, 'scheme'), CONNECTOR_SCHEMES, 'scheme');
  rejectUnknown(
    record,
    [
      'scheme',
      'root',
      'bucket',
      'region',
      'prefix',
      'endpoint',
      'folderId',
      'ignoreHidden',
      'kinds',
    ],
    'connector',
  );
  if (scheme === 'custom' && entry === undefined) {
    throw new PluginError('invalid-manifest', 'A custom connector needs an entry module');
  }
  const config: ConnectorConfig = {
    scheme,
    ignoreHidden: record.ignoreHidden === undefined ? true : booleanField(record, 'ignoreHidden'),
    kinds: record.kinds === undefined ? [] : kindRules(record.kinds),
  };
  if (MOUNT_SCHEMES.has(scheme)) {
    config.root = absolutePath(stringField(record, 'root'));
    rejectPresent(record, ['bucket', 'region', 'prefix', 'endpoint', 'folderId'], scheme);
  }
  if (scheme === 's3') {
    config.bucket = bucketName(stringField(record, 'bucket'));
    config.region = token(stringField(record, 'region'), 'region');
    config.prefix = record.prefix === undefined ? '' : s3Prefix(stringField(record, 'prefix'));
    if (record.endpoint !== undefined) config.endpoint = httpsUrl(stringField(record, 'endpoint'));
    rejectPresent(record, ['root', 'folderId'], scheme);
  }
  if (scheme === 'dropbox') {
    config.prefix = dropboxPrefix(stringField(record, 'prefix'));
    rejectPresent(record, ['root', 'bucket', 'region', 'endpoint', 'folderId'], scheme);
  }
  if (scheme === 'googledrive' || scheme === 'box') {
    config.folderId = folderId(stringField(record, 'folderId'));
    rejectPresent(record, ['root', 'bucket', 'region', 'prefix', 'endpoint'], scheme);
  }
  return config;
}

function parsePlayer(value: unknown): PlayerConfig {
  const record = object(value, 'player');
  rejectUnknown(record, ['systems', 'module'], 'player');
  const systems = stringArray(record.systems, 'systems');
  if (systems.length === 0) throw new PluginError('invalid-manifest', 'A player lists its systems');
  for (const system of systems) {
    if (!SYSTEM_ID.test(system) || system.length > 120) {
      throw new PluginError('invalid-manifest', `System identifier is not dotted: ${system}`);
    }
  }
  const module = relativeFile(stringField(record, 'module'));
  if (!module.endsWith('.wasm')) {
    throw new PluginError('invalid-manifest', 'A player module is a .wasm file');
  }
  return { systems, module };
}

function parseSigner(value: unknown): SignerConfig {
  const record = object(value, 'signer');
  rejectUnknown(record, ['tool', 'certificate', 'profile'], 'signer');
  if (stringField(record, 'tool') !== 'zsign') {
    throw new PluginError(
      'invalid-manifest',
      'The built-in signer plans zsign and does not run it',
    );
  }
  return {
    tool: 'zsign',
    certificate: relativeFile(stringField(record, 'certificate')),
    profile: relativeFile(stringField(record, 'profile')),
  };
}

function parseJit(value: unknown): JitConfig {
  const record = object(value, 'jit');
  rejectUnknown(record, ['tool'], 'jit');
  if (stringField(record, 'tool') !== 'pymobiledevice3') {
    throw new PluginError(
      'invalid-manifest',
      'The built-in JIT planner plans pymobiledevice3 and does not run it',
    );
  }
  return { tool: 'pymobiledevice3' };
}

function kindRules(value: unknown): KindRule[] {
  if (!Array.isArray(value)) throw new PluginError('invalid-manifest', 'kinds must be a list');
  return value.map((item) => {
    const record = object(item, 'kind rule');
    rejectUnknown(record, ['suffix', 'kind'], 'kind rule');
    const suffix = stringField(record, 'suffix');
    if (
      !suffix.startsWith('.') ||
      suffix.includes('/') ||
      suffix.includes('\\') ||
      suffix.length > 32
    ) {
      throw new PluginError('invalid-manifest', 'A kind suffix is a file extension');
    }
    const kind = stringField(record, 'kind');
    if (!isAssetKind(kind)) throw new PluginError('invalid-manifest', `Unknown asset kind ${kind}`);
    return { suffix, kind: kind as AssetKindName };
  });
}

function assertNoSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertNoSecrets(item, `${path}[${index}]`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      throw new PluginError('secret-in-manifest', `${path}.${key} does not belong in plugin.json`);
    }
    assertNoSecrets(child, `${path}.${key}`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginError('invalid-manifest', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  for (const key of keys) {
    if (record[key] === undefined) {
      throw new PluginError('invalid-manifest', `${label} is missing ${key}`);
    }
  }
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new PluginError('invalid-manifest', `${label} has unknown field ${key}`);
    }
  }
}

function rejectPresent(
  record: Record<string, unknown>,
  keys: readonly string[],
  scheme: string,
): void {
  for (const key of keys) {
    if (record[key] !== undefined) {
      throw new PluginError('invalid-manifest', `${scheme} does not take ${key}`);
    }
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PluginError('invalid-manifest', `${key} must be a string`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean')
    throw new PluginError('invalid-manifest', `${key} must be a boolean`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new PluginError('invalid-manifest', `${label} must be a list of strings`);
  }
  return value as string[];
}

function bundleList(value: unknown): string[] {
  const list = stringArray(value, 'apps');
  if (new Set(list).size !== list.length) {
    throw new PluginError('invalid-manifest', 'apps lists a bundle id twice');
  }
  for (const bundle of list) {
    if (!BUNDLE_ID.test(bundle) || bundle.length > 200) {
      throw new PluginError('invalid-manifest', `Bundle id is not dotted: ${bundle}`);
    }
  }
  return list;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  const match = allowed.find((item) => item === value);
  if (!match)
    throw new PluginError('invalid-manifest', `${label} is not one of ${allowed.join(', ')}`);
  return match;
}

function identifier(value: string, label: string): string {
  if (!PLUGIN_ID.test(value) || value.length > 120) {
    throw new PluginError('invalid-manifest', `${label} must be a lowercase dotted id`);
  }
  return value;
}

function shortText(value: string, label: string, max: number): string {
  if (value.length > max || value.includes('\0')) {
    throw new PluginError('invalid-manifest', `${label} is empty or too long`);
  }
  return value;
}

function relativeFile(value: string): string {
  if (value.startsWith('/') || value.includes('\\') || value.split('/').includes('..')) {
    throw new PluginError(
      'invalid-manifest',
      'A plugin path must stay inside the plugin directory',
    );
  }
  if (value.split('/').some((part) => part.length === 0)) {
    throw new PluginError(
      'invalid-manifest',
      'A plugin path must stay inside the plugin directory',
    );
  }
  return value;
}

function absolutePath(value: string): string {
  if (!isAbsolute(value))
    throw new PluginError('invalid-manifest', 'A mount root must be absolute');
  return value;
}

function bucketName(value: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value)) {
    throw new PluginError('invalid-manifest', 'S3 bucket name is not valid');
  }
  return value;
}

function token(value: string, label: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(value)) {
    throw new PluginError('invalid-manifest', `${label} has an unexpected shape`);
  }
  return value;
}

function s3Prefix(value: string): string {
  if (value.includes('..') || value.startsWith('/') || value.includes('\\')) {
    throw new PluginError('invalid-manifest', 'S3 prefix must be a relative key prefix');
  }
  return value;
}

function dropboxPrefix(value: string): string {
  if (!value.startsWith('/') || value.length < 2 || value.includes('..') || value.includes('\\')) {
    throw new PluginError(
      'invalid-manifest',
      'Dropbox prefix must be a folder, so a plugin cannot import the whole account',
    );
  }
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function folderId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new PluginError('invalid-manifest', 'folder id has an unexpected shape');
  }
  return value;
}
