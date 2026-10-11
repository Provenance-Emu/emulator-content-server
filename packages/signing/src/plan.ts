import type { AppBundle } from './bundle.js';
import type { PlistValue } from './plist.js';
import type { Profile } from './profile.js';

export interface SigningPlan {
  /** The identifier the signed app will carry, which the profile decides. */
  bundleId: string;
  /** Set when that is not the identifier the IPA arrived with. */
  renamedFrom: string | null;
  teamId: string;
  profileUuid: string;
  entitlements: Record<string, PlistValue>;
  expiresAt: Date;
  /** Whether a debugger may attach, which is the whole basis of JIT. */
  jit: boolean;
}

export type Refusal =
  | 'wrong-platform'
  | 'profile-expired'
  | 'device-not-provisioned'
  | 'bundle-id-not-covered';

export type PlanOutcome =
  | { ok: true; plan: SigningPlan }
  | { ok: false; refusal: Refusal; detail: string };

export interface PlanInput {
  bundle: AppBundle;
  profile: Profile;
  /** The device this build is for. A profile with no device list is enterprise. */
  deviceUdid: string;
  now?: Date;
}

/**
 * Decides whether this profile can sign this app for this device, and what the
 * signed bundle would look like. Every refusal is a prerequisite the operator
 * can fix, so each one says which, rather than failing somewhere inside a tool.
 */
export function planSigning(input: PlanInput): PlanOutcome {
  const { bundle, profile } = input;
  const now = input.now ?? new Date();

  if (bundle.platforms.length > 0 && !bundle.platforms.includes('iPhoneOS')) {
    return {
      ok: false,
      refusal: 'wrong-platform',
      detail: `${bundle.name} is built for ${bundle.platforms.join(', ')} rather than iPhoneOS`,
    };
  }
  if (profile.expiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      refusal: 'profile-expired',
      detail: `The profile ${profile.name} expired on ${profile.expiresAt.toISOString()}`,
    };
  }
  if (profile.deviceUdids.length > 0 && !profile.deviceUdids.includes(input.deviceUdid)) {
    return {
      ok: false,
      refusal: 'device-not-provisioned',
      detail: `The profile ${profile.name} does not list this device`,
    };
  }

  const bundleId = resolveBundleId(bundle.bundleId, profile.bundleIdPattern);
  if (!bundleId) {
    return {
      ok: false,
      refusal: 'bundle-id-not-covered',
      detail: `The profile covers ${profile.bundleIdPattern}, and the app is ${bundle.bundleId}`,
    };
  }

  return {
    ok: true,
    plan: {
      bundleId,
      renamedFrom: bundleId === bundle.bundleId ? null : bundle.bundleId,
      teamId: profile.teamId,
      profileUuid: profile.uuid,
      entitlements: entitlementsFor(profile, bundleId),
      expiresAt: profile.expiresAt,
      jit: profile.allowsDebugging,
    },
  };
}

/**
 * What the app may be called once signed, or nothing when this profile is for a
 * different app. A free account is issued an identifier derived from the app's
 * own with a suffix that keeps it unique to the account, and adopting that is
 * still this app. Adopting an unrelated identifier is not: it would install one
 * app under another's identity and replace whatever was already there.
 */
function resolveBundleId(appBundleId: string, pattern: string): string | null {
  if (pattern === '*') return appBundleId;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return appBundleId.startsWith(prefix) ? appBundleId : null;
  }
  if (pattern === appBundleId) return appBundleId;
  return pattern.startsWith(`${appBundleId}.`) ? pattern : null;
}

/**
 * The profile's entitlements are what Apple agreed to, so they are the ones that
 * get written, with the identifiers pointed at the name this build will have.
 */
function entitlementsFor(profile: Profile, bundleId: string): Record<string, PlistValue> {
  const applicationIdentifier = `${profile.teamId}.${bundleId}`;
  return {
    ...profile.entitlements,
    'application-identifier': applicationIdentifier,
    'keychain-access-groups': [applicationIdentifier],
  };
}

/** How long a build has left, which is what a refresh schedule runs on. */
export function daysUntil(expiresAt: Date, now = new Date()): number {
  return Math.floor((expiresAt.getTime() - now.getTime()) / 86_400_000);
}
