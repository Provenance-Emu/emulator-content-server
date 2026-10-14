import type { RemoteObject, StorageConnector } from './connector.js';
import { PluginError } from './errors.js';
import { safeRelativePath } from './paths.js';
import { encodeKey, parseS3List, s3Host, signS3 } from './s3.js';

export const MAX_LIST_PAGES = 50;
export const MAX_OBJECTS = 100_000;

export interface CloudResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type CloudFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<CloudResponse>;

export interface CloudSecrets {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  accessToken?: string;
}

export interface CloudConnectorConfig {
  id: string;
  scheme: 's3' | 'googledrive' | 'dropbox' | 'box';
  bucket?: string;
  region?: string;
  prefix?: string;
  endpoint?: string;
  folderId?: string;
  secrets: CloudSecrets;
  fetch: CloudFetch;
  now?: () => Date;
}

interface Planned {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export function openCloudConnector(config: CloudConnectorConfig): StorageConnector {
  requireSecrets(config);
  return {
    id: config.id,
    scheme: config.scheme,
    writable: false,
    list: () => listAll(config),
    read: (object, start, endInclusive) => readObject(config, object, start, endInclusive),
  };
}

async function listAll(config: CloudConnectorConfig): Promise<RemoteObject[]> {
  if (config.scheme === 'googledrive' || config.scheme === 'box') {
    return walkFolder(config, required(config.folderId, 'folderId'), '', 0, { count: 0 });
  }
  return listFlat(config);
}

async function listFlat(config: CloudConnectorConfig): Promise<RemoteObject[]> {
  const objects: RemoteObject[] = [];
  const pages = { count: 0 };
  let cursor: string | null = null;
  for (;;) {
    const parsed = await onePage(config, cursor, pages);
    objects.push(...parsed.objects);
    guardCount(config.scheme, objects.length);
    if (!parsed.cursor) return objects;
    cursor = parsed.cursor;
  }
}

async function walkFolder(
  config: CloudConnectorConfig,
  folderId: string,
  pathPrefix: string,
  depth: number,
  pages: { count: number },
): Promise<RemoteObject[]> {
  if (depth > 8) throw new PluginError('cloud-response', 'Folder nesting exceeds 8');
  const objects: RemoteObject[] = [];
  const folders: { id: string; name: string }[] = [];
  let cursor: string | null = null;
  for (;;) {
    const parsed = await onePage(config, cursor, pages, folderId);
    for (const item of parsed.objects) {
      objects.push({ ...item, relativePath: joinRelative(pathPrefix, item.relativePath) });
    }
    folders.push(...parsed.folders);
    guardCount(config.scheme, objects.length);
    if (!parsed.cursor) break;
    cursor = parsed.cursor;
  }
  for (const folder of folders) {
    const nested = await walkFolder(
      config,
      folder.id,
      joinRelative(pathPrefix, folder.name),
      depth + 1,
      pages,
    );
    objects.push(...nested);
    guardCount(config.scheme, objects.length);
  }
  return objects;
}

async function onePage(
  config: CloudConnectorConfig,
  cursor: string | null,
  pages: { count: number },
  folderId?: string,
): Promise<ParsedPage> {
  if (pages.count >= MAX_LIST_PAGES) {
    throw new PluginError(
      'cloud-response',
      `${config.scheme} listing did not finish within ${MAX_LIST_PAGES} pages`,
    );
  }
  pages.count += 1;
  const planned = planList(config, cursor, folderId);
  const response = await call(config.fetch, planned);
  if (response.status !== 200) fail(config.scheme, 'list', response.status);
  return parseList(config, text(response.body));
}

function guardCount(scheme: string, count: number): void {
  if (count > MAX_OBJECTS) {
    throw new PluginError('cloud-response', `${scheme} listing exceeds ${MAX_OBJECTS} objects`);
  }
}

function joinRelative(prefix: string, name: string): string {
  const combined = prefix === '' ? name : `${prefix}/${name}`;
  return safeRelativePath(combined);
}

async function readObject(
  config: CloudConnectorConfig,
  object: RemoteObject,
  start: number,
  endInclusive: number,
): Promise<Uint8Array> {
  if (start < 0 || endInclusive < start) throw new PluginError('bad-range', 'Range is empty');
  const planned = planRead(config, object.locator, start, endInclusive);
  const response = await call(config.fetch, planned);
  if (response.status !== 200 && response.status !== 206)
    fail(config.scheme, 'read', response.status);
  const bytes = response.body;
  const expected = endInclusive - start + 1;
  if (bytes.byteLength !== expected) {
    throw new PluginError(
      'bad-range',
      `${config.scheme} returned ${bytes.byteLength} bytes for a ${expected} byte range`,
    );
  }
  return bytes;
}

function planList(config: CloudConnectorConfig, cursor: string | null, folderId?: string): Planned {
  if (config.scheme === 's3') return planS3List(config, cursor);
  if (config.scheme === 'dropbox') return planDropboxList(config, cursor);
  if (config.scheme === 'googledrive') return planDriveList(config, cursor, folderId);
  return planBoxList(config, cursor, folderId);
}

function planRead(
  config: CloudConnectorConfig,
  locator: string,
  start: number,
  endInclusive: number,
): Planned {
  const range = `bytes=${start}-${endInclusive}`;
  if (config.scheme === 's3') return planS3Read(config, locator, range);
  if (config.scheme === 'dropbox') {
    return {
      method: 'POST',
      url: 'https://content.dropboxapi.com/2/files/download',
      headers: {
        authorization: bearer(config),
        'dropbox-api-arg': JSON.stringify({ path: locator }),
        range,
      },
    };
  }
  if (config.scheme === 'googledrive') {
    return {
      method: 'GET',
      url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(locator)}?alt=media`,
      headers: { authorization: bearer(config), range },
    };
  }
  return {
    method: 'GET',
    url: `https://api.box.com/2.0/files/${encodeURIComponent(locator)}/content`,
    headers: { authorization: bearer(config), range },
  };
}

function planS3List(config: CloudConnectorConfig, cursor: string | null): Planned {
  const bucket = required(config.bucket, 'bucket');
  const region = required(config.region, 'region');
  const { host, basePath } = s3Host(bucket, region, config.endpoint);
  const query: Record<string, string> = { 'list-type': '2' };
  if (config.prefix) query.prefix = config.prefix;
  if (cursor) query['continuation-token'] = cursor;
  return signS3({
    method: 'GET',
    host,
    path: `${basePath}/`,
    query,
    region,
    accessKeyId: required(config.secrets.accessKeyId, 'accessKeyId'),
    secretAccessKey: required(config.secrets.secretAccessKey, 'secretAccessKey'),
    ...(config.secrets.sessionToken ? { sessionToken: config.secrets.sessionToken } : {}),
    now: config.now?.() ?? new Date(),
  });
}

function planS3Read(config: CloudConnectorConfig, key: string, range: string): Planned {
  const bucket = required(config.bucket, 'bucket');
  const region = required(config.region, 'region');
  const { host, basePath } = s3Host(bucket, region, config.endpoint);
  return signS3({
    method: 'GET',
    host,
    path: `${basePath}/${encodeKey(key)}`,
    query: {},
    region,
    accessKeyId: required(config.secrets.accessKeyId, 'accessKeyId'),
    secretAccessKey: required(config.secrets.secretAccessKey, 'secretAccessKey'),
    ...(config.secrets.sessionToken ? { sessionToken: config.secrets.sessionToken } : {}),
    range,
    now: config.now?.() ?? new Date(),
  });
}

function planDropboxList(config: CloudConnectorConfig, cursor: string | null): Planned {
  if (cursor) {
    return {
      method: 'POST',
      url: 'https://api.dropboxapi.com/2/files/list_folder/continue',
      headers: { authorization: bearer(config), 'content-type': 'application/json' },
      body: JSON.stringify({ cursor }),
    };
  }
  return {
    method: 'POST',
    url: 'https://api.dropboxapi.com/2/files/list_folder',
    headers: { authorization: bearer(config), 'content-type': 'application/json' },
    body: JSON.stringify({ path: config.prefix ?? '', recursive: true }),
  };
}

function planDriveList(
  config: CloudConnectorConfig,
  cursor: string | null,
  folderId?: string,
): Planned {
  const folder = folderId ?? required(config.folderId, 'folderId');
  const query = new URLSearchParams({
    q: `'${folder}' in parents and trashed = false`,
    fields: 'files(id,name,size,mimeType),nextPageToken',
    pageSize: '1000',
  });
  if (cursor) query.set('pageToken', cursor);
  return {
    method: 'GET',
    url: `https://www.googleapis.com/drive/v3/files?${query.toString()}`,
    headers: { authorization: bearer(config) },
  };
}

function planBoxList(
  config: CloudConnectorConfig,
  cursor: string | null,
  folderId?: string,
): Planned {
  const folder = folderId ?? required(config.folderId, 'folderId');
  const offset = cursor ?? '0';
  return {
    method: 'GET',
    url: `https://api.box.com/2.0/folders/${folder}/items?limit=1000&offset=${offset}&fields=id,type,name,size`,
    headers: { authorization: bearer(config) },
  };
}

interface ParsedPage {
  objects: RemoteObject[];
  folders: { id: string; name: string }[];
  cursor: string | null;
}

function parseList(config: CloudConnectorConfig, body: string): ParsedPage {
  if (config.scheme === 's3') return parseS3(body, config.prefix ?? '');
  if (config.scheme === 'dropbox') return parseDropbox(body, config.prefix ?? '');
  if (config.scheme === 'googledrive') return parseDrive(body);
  return parseBox(body);
}

function parseS3(body: string, prefix: string): ParsedPage {
  const listed = parseS3List(body);
  const objects = listed.objects.flatMap((item) => {
    const relative = stripPrefix(item.key, prefix);
    if (relative === null) return [];
    return [object(relative, item.key, item.size)];
  });
  return { objects, folders: [], cursor: listed.truncated ? listed.token : null };
}

function parseDropbox(body: string, prefix: string): ParsedPage {
  const parsed = json(body);
  const entries = arrayOf(parsed.entries, 'entries');
  const objects: RemoteObject[] = [];
  for (const entry of entries) {
    if (entry['.tag'] !== 'file') continue;
    const path = stringField(entry, 'path_display') ?? stringField(entry, 'path_lower');
    const size = numberField(entry, 'size');
    if (path === null || size === null) {
      throw new PluginError('cloud-response', 'Dropbox file is missing a path or size');
    }
    const relative = stripPrefix(path, prefix);
    if (relative === null) continue;
    objects.push(object(relative, path, size));
  }
  const hasMore = parsed.has_more === true;
  const cursor = typeof parsed.cursor === 'string' ? parsed.cursor : null;
  if (hasMore && cursor === null) {
    throw new PluginError('cloud-response', 'Dropbox list continues without a cursor');
  }
  return { objects, folders: [], cursor: hasMore ? cursor : null };
}

function parseDrive(body: string): ParsedPage {
  const parsed = json(body);
  const files = arrayOf(parsed.files ?? [], 'files');
  const objects: RemoteObject[] = [];
  const folders: { id: string; name: string }[] = [];
  for (const file of files) {
    const id = cloudId(file, 'id');
    const name = stringField(file, 'name');
    if (name === null) throw new PluginError('cloud-response', 'Drive file is missing a name');
    if (file.mimeType === 'application/vnd.google-apps.folder') {
      folders.push({ id, name: safeRelativePath(name) });
      continue;
    }
    objects.push(object(name, id, numberField(file, 'size') ?? 0));
  }
  const token = typeof parsed.nextPageToken === 'string' ? parsed.nextPageToken : null;
  return { objects, folders, cursor: token };
}

function parseBox(body: string): ParsedPage {
  const parsed = json(body);
  const entries = arrayOf(parsed.entries, 'entries');
  const objects: RemoteObject[] = [];
  const folders: { id: string; name: string }[] = [];
  for (const entry of entries) {
    const id = cloudId(entry, 'id');
    const name = stringField(entry, 'name');
    if (name === null) throw new PluginError('cloud-response', 'Box entry is missing a name');
    if (entry.type === 'folder') {
      folders.push({ id, name: safeRelativePath(name) });
      continue;
    }
    if (entry.type !== 'file') continue;
    const size = numberField(entry, 'size');
    if (size === null) throw new PluginError('cloud-response', 'Box file is missing a size');
    objects.push(object(name, id, size));
  }
  if (entries.length === 0) return { objects, folders, cursor: null };
  const total = typeof parsed.total_count === 'number' ? parsed.total_count : entries.length;
  const offset = typeof parsed.offset === 'number' ? parsed.offset : 0;
  const next = offset + entries.length;
  return { objects, folders, cursor: next < total ? String(next) : null };
}

function object(relativePath: string, locator: string, size: number): RemoteObject {
  return { relativePath: safeRelativePath(relativePath), locator, size, sha256: null, kind: 'rom' };
}

function stripPrefix(key: string, prefix: string): string | null {
  if (prefix === '') return key;
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (key === normalized || key === `${normalized}/`) return null;
  const withSlash = `${normalized}/`;
  if (!key.startsWith(withSlash)) return null;
  return key.slice(withSlash.length);
}

async function call(fetch: CloudFetch, planned: Planned, redirects = 0): Promise<CloudResponse> {
  const response = await fetch(planned.url, {
    method: planned.method,
    headers: planned.headers,
    ...(planned.body !== undefined ? { body: planned.body } : {}),
  });
  if (response.status >= 300 && response.status < 400 && redirects < 3) {
    const location = header(response.headers, 'location');
    if (location === null) throw new PluginError('cloud-response', 'Redirect offered no location');
    const next = new URL(location, planned.url).href;
    const headers = { ...planned.headers };
    delete headers.authorization;
    delete headers.Authorization;
    delete headers['dropbox-api-arg'];
    return call(fetch, { method: 'GET', url: next, headers }, redirects + 1);
  }
  return response;
}

function requireSecrets(config: CloudConnectorConfig): void {
  if (config.scheme === 's3') {
    required(config.secrets.accessKeyId, 'accessKeyId');
    required(config.secrets.secretAccessKey, 'secretAccessKey');
    return;
  }
  required(config.secrets.accessToken, 'accessToken');
}

function bearer(config: CloudConnectorConfig): string {
  return `Bearer ${required(config.secrets.accessToken, 'accessToken')}`;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new PluginError('missing-secret', `${name} is not set`);
  }
  return value;
}

function fail(scheme: string, action: string, status: number): never {
  throw new PluginError('cloud-response', `${scheme} ${action} failed with HTTP ${status}`);
}

function text(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

function json(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PluginError('cloud-response', 'Cloud listing was not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PluginError('cloud-response', 'Cloud listing was not an object');
  }
  return parsed as Record<string, unknown>;
}

function arrayOf(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new PluginError('cloud-response', `${label} was not a list`);
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new PluginError('cloud-response', `${label} has an entry that is not an object`);
    }
    return item as Record<string, unknown>;
  });
}

function cloudId(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key);
  if (value === null || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new PluginError('cloud-response', 'Cloud id has an unexpected shape');
  }
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number(value);
  return null;
}

function header(headers: Record<string, string>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return null;
}
