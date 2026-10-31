import { isAbsolute } from 'node:path';
import { PluginError } from './errors.js';
import type { FeedDraft } from './feed.js';
import { parseFeed } from './feed.js';
import { type AssetKindName, isAssetKind, type KindRule } from './kinds.js';
import { httpsUrl } from './paths.js';

export { assertClaims, claims } from './claims.js';

export const PLUGIN_ENGINE = 'ecs.plugin/1';

export const PLUGIN_KINDS = [
  'connector',
  'player',
  'feed',
  'signer',
  'jit',
  'provider',
  'manager',
] as const;
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
  web?: WebPlayerConfig;
}

export interface WebPlayerFile {
  file: string;
  sha256: string;
}
export interface WebPlayerConfig {
  profileVersion: 1;
  runtime: 'emscripten-esm-v1' | 'retroarch-emscripten-esm' | 'dolphin-wasm-esm';
  filesystem: 'memfs';
  systemFilesDirectory?: string;
  threaded: boolean;
  saveCompletion: 'none' | 'command-reply-v1';
  contentExtensions: string[];
  maxContentBytes: number;
  buildVersion: string;
  loader: WebPlayerFile;
  wasm: WebPlayerFile;
  assets: (WebPlayerFile & { name: string })[];
}

export interface SignerConfig {
  tool: 'zsign';
  certificate: string;
  profile: string;
}

export interface JitConfig {
  tool: 'pymobiledevice3';
}

export const PROVIDER_CAPABILITIES = ['rom', 'metadata', 'artwork', 'patch', 'cheats'] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export interface ProviderConfig {
  capabilities: ProviderCapability[];
  network: boolean;
}

export interface ManagerConfig {
  providers: string[];
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
  provider?: ProviderConfig;
  manager?: ManagerConfig;
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
  if (kind === 'provider' || kind === 'manager') {
    if (!entry) throw new PluginError('invalid-manifest', `${kind} plugins need an entry module`);
    if (kind === 'provider') {
      const config = object(record.provider, 'provider');
      rejectUnknown(config, ['capabilities', 'network'], 'provider');
      const capabilities = stringArray(config.capabilities, 'capabilities').map((capability) =>
        oneOf(capability, PROVIDER_CAPABILITIES, 'capability'),
      );
      if (capabilities.length === 0 || new Set(capabilities).size !== capabilities.length) {
        throw new PluginError('invalid-manifest', 'A provider lists unique capabilities');
      }
      manifest.provider = { capabilities, network: booleanField(config, 'network') };
    } else {
      const config = object(record.manager, 'manager');
      rejectUnknown(config, ['providers'], 'manager');
      const providers = stringArray(config.providers, 'providers').map((id) =>
        identifier(id, 'Provider id'),
      );
      if (providers.length > 32 || new Set(providers).size !== providers.length) {
        throw new PluginError('invalid-manifest', 'A manager lists at most 32 unique providers');
      }
      manifest.manager = { providers };
    }
  }
  if (!['connector', 'provider', 'manager'].includes(kind) && apps.length === 0) {
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
  rejectUnknown(record, ['systems', 'module', 'web'], 'player');
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
  if (systems.length > 64 || new Set(systems).size !== systems.length)
    throw new PluginError('invalid-manifest', 'A player lists at most 64 unique systems');
  return {
    systems,
    module,
    ...(record.web === undefined ? {} : { web: parseWebPlayer(record.web, module) }),
  };
}

function portableWebPlayerName(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) &&
    !value.endsWith('.') &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  );
}

function parseWebPlayer(value: unknown, module: string): WebPlayerConfig {
  const r = object(value, 'player.web');
  rejectUnknown(
    r,
    [
      'profileVersion',
      'runtime',
      'filesystem',
      'threaded',
      'saveCompletion',
      'contentExtensions',
      'maxContentBytes',
      'buildVersion',
      'loader',
      'wasm',
      'assets',
      'systemFilesDirectory',
    ],
    'player.web',
  );
  if (r.profileVersion !== 1 || r.filesystem !== 'memfs' || typeof r.threaded !== 'boolean')
    throw new PluginError(
      'invalid-manifest',
      'Unsupported web player version, filesystem, or threading',
    );
  const runtime = oneOf(
    stringField(r, 'runtime'),
    ['emscripten-esm-v1', 'retroarch-emscripten-esm', 'dolphin-wasm-esm'] as const,
    'runtime',
  );
  const saveCompletion = oneOf(
    stringField(r, 'saveCompletion'),
    ['none', 'command-reply-v1'] as const,
    'saveCompletion',
  );
  if (
    r.threaded !== (runtime === 'dolphin-wasm-esm') ||
    (runtime === 'dolphin-wasm-esm' && saveCompletion !== 'none')
  )
    throw new PluginError(
      'invalid-manifest',
      'Runtime threading or save completion is unsupported',
    );
  const systemFilesDirectory = r.systemFilesDirectory;
  if (
    systemFilesDirectory !== undefined &&
    (typeof systemFilesDirectory !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(systemFilesDirectory) ||
      !portableWebPlayerName(systemFilesDirectory))
  )
    throw new PluginError(
      'invalid-manifest',
      'System-file directory must be one portable folder name',
    );
  const contentExtensions = stringArray(r.contentExtensions, 'contentExtensions');
  if (
    !contentExtensions.length ||
    contentExtensions.length > 32 ||
    new Set(contentExtensions).size !== contentExtensions.length ||
    contentExtensions.some((x) => !/^[a-z0-9]{1,16}$/.test(x))
  )
    throw new PluginError(
      'invalid-manifest',
      'Web player extensions must be unique portable extensions',
    );
  if (
    !Number.isSafeInteger(r.maxContentBytes) ||
    Number(r.maxContentBytes) <= 0 ||
    Number(r.maxContentBytes) > (runtime === 'dolphin-wasm-esm' ? 9 * 1024 ** 3 : 512 * 1024 ** 2)
  )
    throw new PluginError('invalid-manifest', 'Invalid web player content size limit');
  const buildVersion = shortText(stringField(r, 'buildVersion'), 'buildVersion', 128);
  const parseFile = (v: unknown): WebPlayerFile => {
    const f = object(v, 'web player file');
    rejectUnknown(f, ['file', 'sha256'], 'web player file');
    const file = relativeFile(stringField(f, 'file'));
    if (!portableWebPlayerName(file) || file === 'plugin.json')
      throw new PluginError('invalid-manifest', 'Web player files must be flat portable filenames');
    const sha256 = stringField(f, 'sha256');
    if (!/^[a-f0-9]{64}$/.test(sha256))
      throw new PluginError('invalid-manifest', 'Web player file needs SHA-256');
    return { file, sha256 };
  };
  const loader = parseFile(r.loader);
  const wasm = parseFile(r.wasm);
  if (!/\.(?:mjs|js)$/.test(loader.file) || wasm.file !== module)
    throw new PluginError(
      'invalid-manifest',
      'Web player loader must be JavaScript and WASM must match module',
    );
  if (!Array.isArray(r.assets) || r.assets.length > 16)
    throw new PluginError('invalid-manifest', 'Web player lists at most 16 assets');
  const assets = r.assets.map((a) => {
    const f = object(a, 'web player asset');
    rejectUnknown(f, ['name', 'file', 'sha256'], 'web player asset');
    const name = stringField(f, 'name');
    if (!portableWebPlayerName(name) || /^(?:loader\.js|core\.wasm|plugin\.json)$/i.test(name))
      throw new PluginError('invalid-manifest', 'Invalid web player asset name');
    return { name, ...parseFile({ file: f.file, sha256: f.sha256 }) };
  });
  if (
    new Set(assets.map((a) => a.name.toLowerCase())).size !== assets.length ||
    new Set([
      loader.file.toLowerCase(),
      wasm.file.toLowerCase(),
      ...assets.map((a) => a.file.toLowerCase()),
    ]).size !==
      assets.length + 2
  )
    throw new PluginError('invalid-manifest', 'Web player files and names must be unique');
  return {
    profileVersion: 1,
    runtime,
    filesystem: 'memfs',
    threaded: r.threaded as boolean,
    ...(typeof systemFilesDirectory === 'string' ? { systemFilesDirectory } : {}),
    saveCompletion,
    contentExtensions,
    maxContentBytes: Number(r.maxContentBytes),
    buildVersion,
    loader,
    wasm,
    assets,
  };
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
  if (
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.split('/').some((part) => part === '..' || part === '.')
  ) {
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
