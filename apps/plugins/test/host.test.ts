import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ASSET_KINDS as PLUGIN_KINDS, type PluginError } from '@ecs/plugins';
import { ASSET_KINDS } from '@ecs/protocol';
import type { PlistValue } from '@ecs/signing';
import { resolveToken, run } from '../src/host.js';
import { reviewSigner } from '../src/sign.js';
import { syncItem } from '../src/sync.js';

const examples = new URL('../../../../examples/plugins/', import.meta.url);

test('plugin asset kinds stay aligned with the content contract', () => {
  assert.deepEqual([...PLUGIN_KINDS], [...ASSET_KINDS]);
});

test('a bearer token on the command line is refused without being repeated', () => {
  assert.throws(
    () => resolveToken(['node', 'ecs-plugins', 'sync', '--token', 'super-secret-token'], {}),
    (error: PluginError) => {
      assert.equal(error.code, 'token-on-command-line');
      assert.equal(error.message.includes('super-secret-token'), false);
      return true;
    },
  );
});

test('feed writes one AltStore source per plugin', async () => {
  const out = await mkdtemp(join(tmpdir(), 'ecs-plugin-feed-'));
  const lines: string[] = [];
  const code = await run(
    ['node', 'ecs-plugins', 'feed', '--plugins', fileUrl(examples), '--out', out],
    {},
    { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  );
  assert.equal(code, 0, lines.join('\n'));
  const source = JSON.parse(
    await readFile(join(out, 'org.provenance-emu.provenance.feed.json'), 'utf8'),
  ) as { identifier: string; apps: { bundleIdentifier: string }[] };
  assert.equal(source.identifier, 'org.provenance-emu.provenance.feed');
  assert.equal(source.apps[0]?.bundleIdentifier, 'org.provenance-emu.provenance');
  const icube = JSON.parse(
    await readFile(join(out, 'org.provenance-emu.icube.feed.json'), 'utf8'),
  ) as { apps: { bundleIdentifier: string }[] };
  assert.equal(
    icube.apps.some((app) => app.bundleIdentifier.includes('provenance.feed')),
    false,
  );
  await rm(out, { recursive: true, force: true });
});

test('sync uploads a new file and keeps a differing save', async () => {
  const uploads: { relativePath: string; baseRevision: number; kind: string }[] = [];
  const bytes = new TextEncoder().encode('save-bytes');
  const report = await syncItem({
    libraryId: 'lib',
    itemId: 'item',
    kinds: [{ suffix: '.sav', kind: 'battery_save' }],
    direction: 'push',
    connector: {
      id: 'memory',
      scheme: 'custom',
      writable: false,
      async list() {
        return [
          {
            relativePath: 'battery.sav',
            locator: 'battery.sav',
            size: bytes.byteLength,
            sha256: null,
            kind: 'rom',
          },
          {
            relativePath: 'game.nes',
            locator: 'game.nes',
            size: 3,
            sha256: null,
            kind: 'rom',
          },
        ];
      },
      async read(object) {
        return object.relativePath.endsWith('.sav') ? bytes : new Uint8Array([1, 2, 3]);
      },
    },
    client: {
      async manifest() {
        return {
          revision: 2,
          files: [
            { id: 'live', kind: 'battery_save', relativePath: 'battery.sav', sha256: 'different' },
          ],
        };
      },
      async upload(request) {
        uploads.push({
          relativePath: request.relativePath,
          baseRevision: request.baseRevision,
          kind: request.kind,
        });
      },
      async collect() {
        return { bytes: new Uint8Array(), etag: null };
      },
    },
  });
  assert.deepEqual(
    uploads.map((item) => [item.relativePath, item.kind, item.baseRevision]),
    [
      ['battery.sav', 'battery_save', 0],
      ['game.nes', 'rom', 3],
    ],
  );
  assert.deepEqual(report.uploaded, ['battery.sav', 'game.nes']);
  assert.equal(report.refused.length, 0);
});

test('a signer plugin refuses an app it does not claim', () => {
  const reviewed = reviewSigner({
    apps: ['org.provenance-emu.provenance'],
    bundle: bundle('org.other.app'),
    profile: profile('org.other.app'),
    deviceUdid: 'device',
    ipa: 'in.ipa',
    output: 'out.ipa',
    certificate: 'identity.p12',
    profilePath: 'app.mobileprovision',
    now: new Date('2026-01-01T00:00:00Z'),
  });
  assert.equal(reviewed.ok, false);
  if (!reviewed.ok) assert.equal(reviewed.refusal, 'app-not-claimed');
});

test('a claimed app produces a zsign plan with no password argument', () => {
  const reviewed = reviewSigner({
    apps: ['org.provenance-emu.provenance'],
    bundle: bundle('org.provenance-emu.provenance'),
    profile: profile('org.provenance-emu.provenance'),
    deviceUdid: 'device',
    ipa: 'in.ipa',
    output: 'out.ipa',
    certificate: 'identity.p12',
    profilePath: 'app.mobileprovision',
    now: new Date('2026-01-01T00:00:00Z'),
  });
  assert.equal(reviewed.ok, true);
  if (!reviewed.ok) return;
  const argv = reviewed.plan.steps[0] ?? [];
  assert.equal(reviewed.plan.spawn, false);
  assert.equal(argv.includes('-p'), false);
  assert.equal(argv.includes('--password'), false);
  assert.equal(argv.includes('org.provenance-emu.provenance'), true);
});

function fileUrl(url: URL): string {
  return url.pathname;
}

function bundle(bundleId: string) {
  return {
    path: 'Payload/App.app/',
    bundleId,
    name: 'App',
    version: '1.0',
    build: null,
    minimumOsVersion: '15.0',
    executable: 'App',
    platforms: ['iPhoneOS'],
    embeddedProfile: null,
  };
}

function profile(pattern: string) {
  const entitlements: Record<string, PlistValue> = {
    'application-identifier': `TEAM.${pattern}`,
    'com.apple.developer.team-identifier': 'TEAM',
    'get-task-allow': true,
  };
  return {
    name: 'Dev',
    uuid: '00000000-0000-0000-0000-000000000000',
    teamId: 'TEAM',
    applicationIdentifier: `TEAM.${pattern}`,
    bundleIdPattern: pattern,
    entitlements,
    deviceUdids: ['device'],
    expiresAt: new Date('2027-01-01T00:00:00Z'),
    allowsDebugging: true,
  };
}
