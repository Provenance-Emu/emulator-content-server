import {
  isDictionary,
  type PlistValue,
  parseXmlPlist,
  requireDate,
  requireString,
  stringList,
} from './plist.js';

export interface Profile {
  name: string;
  uuid: string;
  teamId: string;
  /** Entitlement value of `application-identifier`, team prefix included. */
  applicationIdentifier: string;
  /** The identifier without its team prefix, which may end in a wildcard. */
  bundleIdPattern: string;
  entitlements: Record<string, PlistValue>;
  deviceUdids: string[];
  expiresAt: Date;
  /** True when the profile allows a debugger to attach, which is what JIT needs. */
  allowsDebugging: boolean;
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

/**
 * A `.mobileprovision` is an XML property list wrapped in a CMS signature. The
 * plist is read out of the wrapper directly instead of verifying the signature:
 * Apple's signature says the profile came from Apple, and the device checks that
 * at install time, which it will do whatever this code concludes. Reading it
 * here only decides what to attempt, so a forged profile costs a failed install
 * rather than a bad one.
 */
export function parseProfile(bytes: Uint8Array): Profile {
  const plist = unwrap(bytes);
  const value = parseXmlPlist(plist);
  if (!isDictionary(value)) throw new ProfileError('The profile is not a dictionary');
  const entitlements = value.Entitlements;
  if (!entitlements || !isDictionary(entitlements)) {
    throw new ProfileError('The profile grants no entitlements');
  }
  const applicationIdentifier = requireString(entitlements, 'application-identifier');
  const teamId = requireString(entitlements, 'com.apple.developer.team-identifier');
  const prefix = `${teamId}.`;
  if (!applicationIdentifier.startsWith(prefix)) {
    throw new ProfileError('The application identifier does not carry the team prefix');
  }
  return {
    name: requireString(value, 'Name'),
    uuid: requireString(value, 'UUID'),
    teamId,
    applicationIdentifier,
    bundleIdPattern: applicationIdentifier.slice(prefix.length),
    entitlements,
    deviceUdids: stringList(value, 'ProvisionedDevices'),
    expiresAt: requireDate(value, 'ExpirationDate'),
    allowsDebugging: entitlements['get-task-allow'] === true,
  };
}

/** The plist sits in the signed content of the CMS wrapper as readable text. */
function unwrap(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes).toString('latin1');
  const start = text.indexOf('<?xml');
  const end = text.lastIndexOf('</plist>');
  if (start === -1 || end === -1) throw new ProfileError('No property list inside the profile');
  return bytes.subarray(start, end + '</plist>'.length);
}
