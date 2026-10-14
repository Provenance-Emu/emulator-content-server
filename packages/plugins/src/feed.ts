import { assertClaims } from './claims.js';
import { PluginError } from './errors.js';
import { httpsUrl } from './paths.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TINT = /^[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;

export interface FeedVersion {
  version: string;
  date: string;
  localizedDescription: string;
  downloadURL: string;
  size: number;
  minOSVersion?: string;
}

export interface FeedPermission {
  type: string;
  usageDescription: string;
}

export interface FeedApp {
  name: string;
  bundleIdentifier: string;
  developerName: string;
  subtitle?: string;
  localizedDescription: string;
  iconURL: string;
  tintColor?: string;
  screenshotURLs: string[];
  permissions: FeedPermission[];
  versions: FeedVersion[];
}

export interface FeedDraft {
  identifier: string;
  sourceURL: string;
  apps: FeedApp[];
}

export interface AltStoreVersion {
  version: string;
  date: string;
  localizedDescription: string;
  downloadURL: string;
  size: number;
  minOSVersion?: string;
}

export interface AltStoreApp {
  name: string;
  bundleIdentifier: string;
  developerName: string;
  subtitle?: string;
  localizedDescription: string;
  iconURL: string;
  tintColor?: string;
  screenshotURLs: string[];
  permissions?: FeedPermission[];
  version: string;
  versionDate: string;
  versionDescription: string;
  downloadURL: string;
  size: number;
  versions: AltStoreVersion[];
}

/**
 * One AltStore source. Legacy flat fields mirror the newest version so an older
 * client still sees a build, and `versions` is what current AltStore and
 * SideStore read. Each plugin is its own source, so another developer publishes
 * their apps by adding a plugin rather than by editing this one.
 */
export interface AltStoreSource {
  name: string;
  identifier: string;
  sourceURL: string;
  apps: AltStoreApp[];
  news: [];
}

export function parseFeed(value: unknown, claimed: readonly string[]): FeedDraft {
  const record = object(value, 'feed');
  rejectUnknown(record, ['identifier', 'sourceURL', 'apps'], 'feed');
  const appsValue = record.apps;
  if (!Array.isArray(appsValue) || appsValue.length === 0) {
    throw new PluginError('invalid-manifest', 'A feed lists at least one app');
  }
  const apps = appsValue.map((item) => parseApp(item, claimed));
  if (new Set(apps.map((app) => app.bundleIdentifier)).size !== apps.length) {
    throw new PluginError('invalid-manifest', 'A feed lists a bundle id twice');
  }
  return {
    identifier: dotted(stringField(record, 'identifier'), 'feed identifier'),
    sourceURL: httpsUrl(stringField(record, 'sourceURL')),
    apps,
  };
}

export function renderAltStoreSource(name: string, feed: FeedDraft): AltStoreSource {
  const apps = [...feed.apps]
    .sort((a, b) => a.bundleIdentifier.localeCompare(b.bundleIdentifier))
    .map(renderApp);
  return {
    name,
    identifier: feed.identifier,
    sourceURL: feed.sourceURL,
    apps,
    news: [],
  };
}

function parseApp(value: unknown, claimed: readonly string[]): FeedApp {
  const record = object(value, 'app');
  rejectUnknown(
    record,
    [
      'name',
      'bundleIdentifier',
      'developerName',
      'subtitle',
      'localizedDescription',
      'iconURL',
      'tintColor',
      'screenshotURLs',
      'permissions',
      'versions',
    ],
    'app',
  );
  const bundleIdentifier = stringField(record, 'bundleIdentifier');
  assertClaims(claimed, bundleIdentifier);
  const versionsValue = record.versions;
  if (!Array.isArray(versionsValue) || versionsValue.length === 0) {
    throw new PluginError('invalid-manifest', `${bundleIdentifier} needs a version to publish`);
  }
  const app: FeedApp = {
    name: shortText(stringField(record, 'name'), 'app name'),
    bundleIdentifier,
    developerName: shortText(stringField(record, 'developerName'), 'developer name'),
    localizedDescription: shortText(stringField(record, 'localizedDescription'), 'description'),
    iconURL: httpsUrl(stringField(record, 'iconURL')),
    screenshotURLs:
      record.screenshotURLs === undefined
        ? []
        : stringArray(record.screenshotURLs, 'screenshotURLs').map((url) => httpsUrl(url)),
    permissions: record.permissions === undefined ? [] : permissions(record.permissions),
    versions: versionsValue.map((item) => parseVersion(item)),
  };
  if (record.subtitle !== undefined)
    app.subtitle = shortText(stringField(record, 'subtitle'), 'subtitle');
  if (record.tintColor !== undefined) {
    const tint = stringField(record, 'tintColor');
    if (!TINT.test(tint))
      throw new PluginError('invalid-manifest', 'tintColor is 6 or 8 hex digits');
    app.tintColor = tint.toLowerCase();
  }
  return app;
}

function parseVersion(value: unknown): FeedVersion {
  const record = object(value, 'version');
  rejectUnknown(
    record,
    ['version', 'date', 'localizedDescription', 'downloadURL', 'size', 'minOSVersion'],
    'version',
  );
  const date = stringField(record, 'date');
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(date))) {
    throw new PluginError('invalid-manifest', 'version date must be an ISO timestamp in UTC');
  }
  const size = record.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new PluginError('invalid-manifest', 'version size must be a byte count');
  }
  const version: FeedVersion = {
    version: shortText(stringField(record, 'version'), 'version'),
    date,
    localizedDescription: shortText(stringField(record, 'localizedDescription'), 'version notes'),
    downloadURL: httpsUrl(stringField(record, 'downloadURL')),
    size,
  };
  if (record.minOSVersion !== undefined) {
    version.minOSVersion = shortText(stringField(record, 'minOSVersion'), 'minimum OS');
  }
  return version;
}

function renderApp(app: FeedApp): AltStoreApp {
  const versions = [...app.versions].sort((a, b) => b.date.localeCompare(a.date));
  const current = versions[0];
  if (!current) throw new PluginError('invalid-manifest', `${app.bundleIdentifier} has no version`);
  const rendered: AltStoreApp = {
    name: app.name,
    bundleIdentifier: app.bundleIdentifier,
    developerName: app.developerName,
    localizedDescription: app.localizedDescription,
    iconURL: app.iconURL,
    screenshotURLs: app.screenshotURLs,
    version: current.version,
    versionDate: current.date,
    versionDescription: current.localizedDescription,
    downloadURL: current.downloadURL,
    size: current.size,
    versions: versions.map((version) => {
      const item: AltStoreVersion = {
        version: version.version,
        date: version.date,
        localizedDescription: version.localizedDescription,
        downloadURL: version.downloadURL,
        size: version.size,
      };
      if (version.minOSVersion !== undefined) item.minOSVersion = version.minOSVersion;
      return item;
    }),
  };
  if (app.subtitle !== undefined) rendered.subtitle = app.subtitle;
  if (app.tintColor !== undefined) rendered.tintColor = app.tintColor;
  if (app.permissions.length > 0) rendered.permissions = app.permissions;
  return rendered;
}

function permissions(value: unknown): FeedPermission[] {
  if (!Array.isArray(value))
    throw new PluginError('invalid-manifest', 'permissions must be a list');
  return value.map((item) => {
    const record = object(item, 'permission');
    rejectUnknown(record, ['type', 'usageDescription'], 'permission');
    return {
      type: shortText(stringField(record, 'type'), 'permission type'),
      usageDescription: shortText(stringField(record, 'usageDescription'), 'permission usage'),
    };
  });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginError('invalid-manifest', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
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

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PluginError('invalid-manifest', `${key} must be a string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new PluginError('invalid-manifest', `${label} must be a list of strings`);
  }
  return value as string[];
}

function shortText(value: string, label: string): string {
  if (value.length > 4000) throw new PluginError('invalid-manifest', `${label} is too long`);
  return value;
}

function dotted(value: string, label: string): string {
  if (!/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(value)) {
    throw new PluginError('invalid-manifest', `${label} must be a lowercase dotted id`);
  }
  return value;
}
