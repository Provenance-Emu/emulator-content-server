import { readFile } from 'node:fs/promises';
import { claims, planZsign, type ToolPlan } from '@ecs/plugins';
import type { AppBundle, Profile } from '@ecs/signing';
import { inspectIpa, parseProfile, planSigning } from '@ecs/signing';

export type SignerReview =
  | { ok: true; plan: ToolPlan }
  | { ok: false; refusal: string; detail: string };

/**
 * Decides whether this plugin may sign this app, then plans zsign. The plan is
 * not executed. A password is not accepted here, because the only place zsign
 * would take one is its command line.
 */
export function reviewSigner(input: {
  apps: readonly string[];
  bundle: AppBundle;
  profile: Profile;
  deviceUdid: string;
  ipa: string;
  output: string;
  certificate: string;
  profilePath: string;
  now?: Date;
}): SignerReview {
  if (!claims(input.apps, input.bundle.bundleId)) {
    return {
      ok: false,
      refusal: 'app-not-claimed',
      detail: `${input.bundle.bundleId} is not an app this plugin signs`,
    };
  }
  const outcome = planSigning({
    bundle: input.bundle,
    profile: input.profile,
    deviceUdid: input.deviceUdid,
    ...(input.now ? { now: input.now } : {}),
  });
  if (!outcome.ok) return outcome;
  if (!claims(input.apps, outcome.plan.bundleId)) {
    return {
      ok: false,
      refusal: 'app-not-claimed',
      detail: `${outcome.plan.bundleId} is not an app this plugin signs`,
    };
  }
  return {
    ok: true,
    plan: planZsign({
      apps: input.apps,
      bundleId: outcome.plan.bundleId,
      ipa: input.ipa,
      output: input.output,
      certificate: input.certificate,
      profile: input.profilePath,
    }),
  };
}

/** Reads the IPA and the profile, then plans. The certificate file is not opened. */
export async function reviewSignerFiles(input: {
  apps: readonly string[];
  ipaPath: string;
  profilePath: string;
  deviceUdid: string;
  output: string;
  certificate: string;
  now?: Date;
}): Promise<SignerReview> {
  const bundle = await inspectIpa(input.ipaPath);
  const profile = parseProfile(new Uint8Array(await readFile(input.profilePath)));
  return reviewSigner({
    apps: input.apps,
    bundle,
    profile,
    deviceUdid: input.deviceUdid,
    ipa: input.ipaPath,
    output: input.output,
    certificate: input.certificate,
    profilePath: input.profilePath,
    ...(input.now ? { now: input.now } : {}),
  });
}
