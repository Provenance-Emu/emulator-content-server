import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  type AppBundle,
  BundleError,
  daysUntil,
  inspectIpa,
  PlistError,
  parseBinaryPlist,
  parsePlist,
  parseProfile,
  planSigning,
} from '../src/index.js';
import { binaryPlist, ipa, mobileprovision, pattern, xmlPlist, zip } from './fixtures.js';

async function writeTemporary(name: string, bytes: Uint8Array | Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-signing-'));
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

test('a property list reads the same whether it arrived as XML or as bytes', () => {
  const value = {
    CFBundleIdentifier: 'com.provenance.probe',
    CFBundleSupportedPlatforms: ['iPhoneOS'],
    LSRequiresIPhoneOS: true,
    UIRequiredDeviceCapabilities: { arm64: true },
    CountOfThings: 42,
    Thumbnail: pattern(40),
  };
  const fromXml = parsePlist(xmlPlist(value));
  const fromBinary = parsePlist(binaryPlist(value));
  assert.deepEqual(fromXml, fromBinary);
  assert.deepEqual(fromBinary, { ...value, Thumbnail: pattern(40) });
});

test('a binary plist with a long string and a date survives the round trip', () => {
  const long = 'c'.repeat(300);
  const when = new Date('2026-03-04T05:06:07.000Z');
  const parsed = parseBinaryPlist(binaryPlist({ note: long, when }));
  assert.deepEqual(parsed, { note: long, when });
});

test('a property list that is not one is refused rather than guessed at', () => {
  assert.throws(() => parsePlist(new Uint8Array(Buffer.from('not a plist', 'utf8'))), PlistError);
  assert.throws(() => parseBinaryPlist(new Uint8Array(8)), PlistError);
});

test('an IPA reports what it says about itself, not what it is named', async () => {
  const profile = mobileprovision();
  const path = await writeTemporary(
    'Probe-1.0.ipa',
    ipa({ bundleId: 'com.provenance.probe', name: 'Probe', binaryInfo: true, profile }),
  );
  try {
    const bundle = await inspectIpa(path);
    assert.equal(bundle.bundleId, 'com.provenance.probe');
    assert.equal(bundle.path, 'Payload/Probe.app/');
    assert.equal(bundle.executable, 'Probe');
    assert.equal(bundle.minimumOsVersion, '16.0');
    assert.deepEqual(bundle.platforms, ['iPhoneOS']);
    assert.ok(bundle.embeddedProfile, 'the profile the IPA shipped with is read out');
    assert.equal(parseProfile(bundle.embeddedProfile).uuid, parseProfile(profile).uuid);
  } finally {
    await rm(join(path, '..'), { recursive: true, force: true });
  }
});

test('an archive that is not one app in a payload is refused', async () => {
  const two = zip([
    { name: 'Payload/One.app/Info.plist', bytes: xmlPlist({ CFBundleIdentifier: 'one' }) },
    { name: 'Payload/Two.app/Info.plist', bytes: xmlPlist({ CFBundleIdentifier: 'two' }) },
  ]);
  const path = await writeTemporary('Two.ipa', two);
  await assert.rejects(inspectIpa(path), BundleError);

  const empty = await writeTemporary('Empty.ipa', zip([{ name: 'README.txt', bytes: pattern(8) }]));
  await assert.rejects(inspectIpa(empty), BundleError);
});

test('a profile reports its team, its devices, and when it stops working', () => {
  const expiresAt = new Date('2026-12-01T00:00:00.000Z');
  const profile = parseProfile(
    mobileprovision({ teamId: 'TEAM123456', devices: ['udid-one', 'udid-two'], expiresAt }),
  );
  assert.equal(profile.teamId, 'TEAM123456');
  assert.equal(profile.applicationIdentifier, 'TEAM123456.com.provenance.probe');
  assert.equal(profile.bundleIdPattern, 'com.provenance.probe');
  assert.deepEqual(profile.deviceUdids, ['udid-one', 'udid-two']);
  assert.equal(profile.expiresAt.toISOString(), expiresAt.toISOString());
  assert.ok(profile.allowsDebugging, 'a development profile allows a debugger to attach');
  assert.equal(daysUntil(expiresAt, new Date('2026-11-24T00:00:00.000Z')), 7);
});

const bundle: AppBundle = {
  path: 'Payload/Probe.app/',
  bundleId: 'com.provenance.probe',
  name: 'Probe',
  version: '1.0',
  build: '1',
  minimumOsVersion: '16.0',
  executable: 'Probe',
  platforms: ['iPhoneOS'],
  embeddedProfile: null,
};

test('a plan says what the signed app will be called and whether JIT is possible', () => {
  const profile = parseProfile(mobileprovision({ devices: ['device-udid'] }));
  const outcome = planSigning({ bundle, profile, deviceUdid: 'device-udid' });
  assert.ok(outcome.ok, 'the profile covers this app and this device');
  assert.equal(outcome.plan.bundleId, 'com.provenance.probe');
  assert.equal(outcome.plan.renamedFrom, null);
  assert.equal(outcome.plan.teamId, 'ABCDE12345');
  assert.equal(outcome.plan.jit, true);
  assert.deepEqual(
    outcome.plan.entitlements['application-identifier'],
    'ABCDE12345.com.provenance.probe',
  );
  assert.deepEqual(outcome.plan.entitlements['keychain-access-groups'], [
    'ABCDE12345.com.provenance.probe',
  ]);
});

test('a plan adopts the identifier the profile names rather than the app its own', () => {
  const profile = parseProfile(
    mobileprovision({ bundleIdPattern: 'com.provenance.probe.ABCDE', devices: ['device-udid'] }),
  );
  const outcome = planSigning({ bundle, profile, deviceUdid: 'device-udid' });
  assert.ok(outcome.ok);
  assert.equal(outcome.plan.bundleId, 'com.provenance.probe.ABCDE');
  assert.equal(outcome.plan.renamedFrom, 'com.provenance.probe', 'and says it had to');
});

test('a wildcard profile leaves an app alone', () => {
  const wide = parseProfile(mobileprovision({ bundleIdPattern: '*', devices: ['device-udid'] }));
  const outcome = planSigning({ bundle, profile: wide, deviceUdid: 'device-udid' });
  assert.ok(outcome.ok);
  assert.equal(outcome.plan.bundleId, 'com.provenance.probe');

  const prefixed = parseProfile(
    mobileprovision({ bundleIdPattern: 'com.provenance.*', devices: ['device-udid'] }),
  );
  const under = planSigning({ bundle, profile: prefixed, deviceUdid: 'device-udid' });
  assert.ok(under.ok);
  assert.equal(under.plan.bundleId, 'com.provenance.probe');

  const elsewhere = planSigning({
    bundle: { ...bundle, bundleId: 'org.other.app' },
    profile: prefixed,
    deviceUdid: 'device-udid',
  });
  assert.equal(elsewhere.ok, false, 'an app outside the prefix is not quietly moved under it');
});

test('every prerequisite that is missing is named instead of failing inside a tool', () => {
  const profile = parseProfile(mobileprovision({ devices: ['device-udid'] }));

  const wrongDevice = planSigning({ bundle, profile, deviceUdid: 'another-device' });
  assert.equal(wrongDevice.ok, false);
  assert.equal(wrongDevice.ok === false && wrongDevice.refusal, 'device-not-provisioned');

  const expired = planSigning({
    bundle,
    profile: parseProfile(
      mobileprovision({
        devices: ['device-udid'],
        expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
    ),
    deviceUdid: 'device-udid',
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.ok === false && expired.refusal, 'profile-expired');

  const mac = planSigning({
    bundle: { ...bundle, platforms: ['MacOSX'] },
    profile,
    deviceUdid: 'device-udid',
  });
  assert.equal(mac.ok, false);
  assert.equal(mac.ok === false && mac.refusal, 'wrong-platform');

  const elsewhere = planSigning({
    bundle: { ...bundle, bundleId: 'org.other.app' },
    profile,
    deviceUdid: 'device-udid',
  });
  assert.equal(elsewhere.ok, false);
  assert.equal(elsewhere.ok === false && elsewhere.refusal, 'bundle-id-not-covered');
});

test('a profile with no devices is taken as covering any of them', () => {
  const enterprise = parseProfile(mobileprovision({ devices: [] }));
  const outcome = planSigning({ bundle, profile: enterprise, deviceUdid: 'any-device' });
  assert.ok(outcome.ok, 'an enterprise profile lists no device and still signs');
});
