import { Archive, ArchiveError } from './archive.js';
import { optionalString, parsePlistDictionary, requireString, stringList } from './plist.js';

/** An `Info.plist` or an embedded profile past this size is not one. */
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

export interface AppBundle {
  /** Path of the `.app` directory inside the archive, with a trailing slash. */
  path: string;
  bundleId: string;
  name: string;
  version: string;
  build: string | null;
  minimumOsVersion: string | null;
  executable: string;
  platforms: string[];
  /** Bytes of the profile the IPA already carries, if it carries one. */
  embeddedProfile: Uint8Array | null;
}

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

/**
 * Reads what an IPA says about itself. Nothing here trusts the file name: the
 * bundle identifier, the executable, and the platform all come from the
 * `Info.plist` that iOS itself will read.
 */
export async function inspectIpa(path: string): Promise<AppBundle> {
  const archive = await Archive.open(path);
  try {
    const app = appDirectory(archive);
    const info = parsePlistDictionary(await archive.read(`${app}Info.plist`, MAX_METADATA_BYTES));
    return {
      path: app,
      bundleId: requireString(info, 'CFBundleIdentifier'),
      name: optionalString(info, 'CFBundleDisplayName') ?? requireString(info, 'CFBundleName'),
      version: optionalString(info, 'CFBundleShortVersionString') ?? '0',
      build: optionalString(info, 'CFBundleVersion') ?? null,
      minimumOsVersion: optionalString(info, 'MinimumOSVersion') ?? null,
      executable: requireString(info, 'CFBundleExecutable'),
      platforms: stringList(info, 'CFBundleSupportedPlatforms'),
      embeddedProfile: await optionalEntry(archive, `${app}embedded.mobileprovision`),
    };
  } finally {
    await archive.close();
  }
}

function appDirectory(archive: Archive): string {
  const payload = archive.childrenOf('Payload/');
  const apps = payload.filter((name) => name.endsWith('.app'));
  if (apps.length === 0) throw new BundleError('No .app directory inside Payload');
  if (apps.length > 1) throw new BundleError('More than one .app directory inside Payload');
  return `Payload/${apps[0]}/`;
}

async function optionalEntry(archive: Archive, name: string): Promise<Uint8Array | null> {
  if (!archive.find(name)) return null;
  try {
    return await archive.read(name, MAX_METADATA_BYTES);
  } catch (error) {
    if (error instanceof ArchiveError) return null;
    throw error;
  }
}
