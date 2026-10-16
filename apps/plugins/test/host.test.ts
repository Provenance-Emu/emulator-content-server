import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { ASSET_KINDS as PLUGIN_KINDS, type PluginError } from '@ecs/plugins';
import { ASSET_KINDS } from '@ecs/protocol';
import type { PlistValue } from '@ecs/signing';
import { resolveToken, run } from '../src/host.js';
import { respondToFeed, serveFeeds } from '../src/publish.js';
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

test('a library file the mount does not have is written beside it', async () => {
  const written: { path: string; text: string }[] = [];
  const report = await syncItem({
    libraryId: 'lib',
    itemId: 'item',
    kinds: [],
    direction: 'both',
    connector: {
      id: 'mount',
      scheme: 'smb',
      writable: true,
      async list() {
        return [];
      },
      async read() {
        return new Uint8Array();
      },
      async put(path, bytes) {
        written.push({ path, text: Buffer.from(bytes).toString() });
      },
    },
    client: {
      async manifest() {
        return {
          revision: 1,
          files: [{ id: 'rom', kind: 'rom', relativePath: 'game.nes', sha256: 'abc' }],
        };
      },
      async upload() {
        throw new Error('the mount was missing the file, so nothing is uploaded');
      },
      async collect() {
        return { bytes: new Uint8Array(Buffer.from('rom-from-library')), etag: null };
      },
    },
  });
  assert.deepEqual(written, [{ path: 'game.nes', text: 'rom-from-library' }]);
  assert.deepEqual(report.downloaded, ['game.nes']);
});

test('a feed server rewrites its source URL and does not serve anything else', async () => {
  const feeds = [
    {
      id: 'org.example.feed',
      name: 'Example',
      source: {
        name: 'Example',
        identifier: 'org.example.feed',
        sourceURL: 'https://example.invalid/apps.json',
        apps: [],
        news: [] as [],
      },
    },
  ];
  assert.equal(respondToFeed(feeds, 'GET', '/secrets.json', 'http://127.0.0.1:9').status, 404);
  assert.equal(respondToFeed(feeds, 'GET', '/../identity.p12', 'http://127.0.0.1:9').status, 404);
  const server = await serveFeeds(feeds);
  try {
    const index = (await (await fetch(`${server.url}/`)).json()) as {
      sources: { sourceURL: string }[];
    };
    assert.equal(index.sources[0]?.sourceURL, `${server.url}/org.example.feed.json`);
    const source = (await (await fetch(index.sources[0].sourceURL)).json()) as {
      sourceURL: string;
    };
    assert.equal(source.sourceURL, index.sources[0].sourceURL);
    assert.equal((await fetch(`${server.url}/secrets.json`)).status, 404);
  } finally {
    await server.close();
  }
  await assert.rejects(serveFeeds(feeds, { host: '0.0.0.0' }), /loopback/);
});

test('sign-plan reads an IPA and prints zsign without a password', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-plugin-sign-'));
  const plugins = join(dir, 'plugins', 'signer');
  await mkdir(plugins, { recursive: true });
  await writeFile(
    join(plugins, 'plugin.json'),
    JSON.stringify({
      id: 'org.provenance-emu.provenance.signer',
      name: 'Provenance signer',
      kind: 'signer',
      version: '1.0.0',
      engine: 'ecs.plugin/1',
      apps: ['org.provenance-emu.provenance'],
      signer: { tool: 'zsign', certificate: 'identity.p12', profile: 'app.mobileprovision' },
    }),
  );
  const ipa = join(dir, 'Provenance.ipa');
  const profile = join(dir, 'app.mobileprovision');
  await writeFile(ipa, ipaArchive('org.provenance-emu.provenance'));
  await writeFile(profile, profileArchive('org.provenance-emu.provenance'));
  const lines: string[] = [];
  const io = { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  const code = await run(
    [
      'node',
      'ecs-plugins',
      'sign-plan',
      '--plugins',
      join(dir, 'plugins'),
      '--id',
      'org.provenance-emu.provenance.signer',
      '--ipa',
      ipa,
      '--profile',
      profile,
      '--device',
      '00008030-001122334455667788',
    ],
    {},
    io,
  );
  assert.equal(code, 0, lines.join('\n'));
  const planned = (lines[0] ?? '').split(' ');
  assert.equal(planned[0], 'zsign');
  assert.equal(planned.includes('-p'), false);
  assert.equal(planned.includes('--password'), false);
  assert.equal(lines.at(-1), 'not run');
  const refused = await run(
    [
      'node',
      'ecs-plugins',
      'sign-plan',
      '--plugins',
      join(dir, 'plugins'),
      '--id',
      'org.provenance-emu.provenance.signer',
      '--ipa',
      ipa,
      '--profile',
      profile,
      '--device',
      '00008030-001122334455667788',
      '--password',
      'certificate-secret',
    ],
    {},
    io,
  );
  assert.equal(refused, 1);
  assert.equal(
    lines.some((line) => line.includes('certificate-secret')),
    false,
  );
  await rm(dir, { recursive: true, force: true });
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

function ipaArchive(bundleId: string): Buffer {
  const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>Provenance</string>
<key>CFBundleExecutable</key><string>Provenance</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>MinimumOSVersion</key><string>16.0</string>
<key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array>
</dict></plist>`;
  return storedZip([
    { name: 'Payload/Provenance.app/Info.plist', bytes: Buffer.from(info) },
    { name: 'Payload/Provenance.app/Provenance', bytes: Buffer.from('app') },
  ]);
}

function profileArchive(bundleId: string): Buffer {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Name</key><string>Dev</string>
<key>UUID</key><string>11111111-2222-3333-4444-555555555555</string>
<key>ProvisionedDevices</key><array><string>00008030-001122334455667788</string></array>
<key>ExpirationDate</key><date>2027-01-01T00:00:00Z</date>
<key>Entitlements</key><dict>
<key>application-identifier</key><string>ABCDE12345.${bundleId}</string>
<key>com.apple.developer.team-identifier</key><string>ABCDE12345</string>
<key>get-task-allow</key><true/>
</dict>
</dict></plist>`;
  return Buffer.concat([
    Buffer.from('0\u0082signed-data-wrapper\u0000', 'latin1'),
    Buffer.from(plist),
    Buffer.from('\u0000signature-bytes', 'latin1'),
  ]);
}

function storedZip(entries: { name: string; bytes: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, entry.bytes);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.bytes.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + entry.bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
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
