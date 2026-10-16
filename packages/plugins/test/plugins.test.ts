import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type CloudFetch,
  type CloudResponse,
  describePlayer,
  diagnose,
  loadPlugin,
  loadPluginDirectory,
  openConnector,
  openMount,
  PluginError,
  parseManifest,
  planJit,
  planReplication,
  planZsign,
  readSecrets,
  renderAltStoreSource,
  signS3,
} from '../src/index.js';

const examples = fileURLToPath(new URL('../../../../examples/plugins', import.meta.url));

function response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): CloudResponse {
  return { status, headers, body: new Uint8Array(Buffer.from(body)) };
}

test('a feed plugin renders an AltStore source and cannot publish someone else', async () => {
  const loaded = await loadPluginDirectory(examples);
  assert.deepEqual(loaded.problems, []);
  const feeds = loaded.plugins.filter((plugin) => plugin.manifest.kind === 'feed');
  assert.deepEqual(
    feeds.map((plugin) => plugin.manifest.id),
    [
      'org.provenance-emu.icube.feed',
      'org.provenance-emu.ifly.feed',
      'org.provenance-emu.provenance.feed',
    ],
  );
  const provenance = feeds.find((plugin) => plugin.manifest.id.endsWith('provenance.feed'));
  const feed = provenance?.manifest.feed;
  if (!feed) throw new Error('provenance feed missing');
  const source = renderAltStoreSource(provenance.manifest.name, feed);
  assert.equal(source.news.length, 0);
  assert.equal(source.apps.length, 1);
  const app = source.apps[0];
  assert.equal(app?.bundleIdentifier, 'org.provenance-emu.provenance');
  assert.equal(app?.version, app?.versions[0]?.version);
  assert.equal(app?.downloadURL.startsWith('https://'), true);
  assert.throws(
    () =>
      parseManifest({
        id: 'org.example.feed',
        name: 'Example',
        kind: 'feed',
        version: '1.0.0',
        engine: 'ecs.plugin/1',
        apps: ['org.example.app'],
        feed: {
          ...feed,
          apps: [{ ...feed.apps[0], bundleIdentifier: 'org.other.app' }],
        },
      }),
    (error: PluginError) => error.code === 'app-not-claimed',
  );
});

test('credentials do not belong in a plugin manifest', () => {
  assert.throws(
    () =>
      parseManifest({
        id: 'home.library.s3',
        name: 'S3',
        kind: 'connector',
        version: '1.0.0',
        engine: 'ecs.plugin/1',
        connector: {
          scheme: 's3',
          bucket: 'library',
          region: 'us-east-1',
          accessKeyId: 'not-a-real-key',
        },
      }),
    (error: PluginError) => error.code === 'secret-in-manifest',
  );
});

test('a secret file that other users can read is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-plugin-secret-'));
  const path = join(dir, 'secrets.json');
  await writeFile(path, JSON.stringify({ accessToken: 'token-value' }));
  await chmod(path, 0o644);
  await assert.rejects(readSecrets(path), (error: PluginError) => {
    assert.equal(error.code, 'secret-permissions');
    assert.equal(error.message.includes('token-value'), false);
    return true;
  });
  await chmod(path, 0o600);
  assert.deepEqual(await readSecrets(path), { accessToken: 'token-value' });
  await rm(dir, { recursive: true, force: true });
});

test('a save conflict is kept and a ROM conflict is refused', () => {
  const steps = planReplication(
    [
      { relativePath: 'game.nes', locator: 'game.nes', size: 4, sha256: 'aaa', kind: 'rom' },
      {
        relativePath: 'battery.sav',
        locator: 'battery.sav',
        size: 4,
        sha256: 'bbb',
        kind: 'battery_save',
      },
      { relativePath: 'new.nes', locator: 'new.nes', size: 4, sha256: 'ccc', kind: 'rom' },
    ],
    [
      { id: 'live-rom', relativePath: 'game.nes', sha256: 'ddd', kind: 'rom' },
      { id: 'live-save', relativePath: 'battery.sav', sha256: 'eee', kind: 'battery_save' },
    ],
    { direction: 'both', writable: true, itemRevision: 4 },
  );
  const rom = steps.find((step) => step.op === 'refuse' && step.relativePath === 'game.nes');
  const save = steps.find((step) => step.op === 'upload' && step.relativePath === 'battery.sav');
  const added = steps.find((step) => step.op === 'upload' && step.relativePath === 'new.nes');
  assert.equal(rom?.op, 'refuse');
  assert.equal(save?.op === 'upload' && save.keepBoth && save.baseRevision === 0, true);
  assert.equal(added?.op === 'upload' && added.baseRevision === 5, true);
});

test('bytes already stored under a conflict name are not uploaded again', () => {
  const steps = planReplication(
    [
      {
        relativePath: 'battery.sav',
        locator: 'battery.sav',
        size: 4,
        sha256: 'bbb',
        kind: 'battery_save',
      },
    ],
    [
      { id: 'live', relativePath: 'battery.sav', sha256: 'eee', kind: 'battery_save' },
      {
        id: 'copy',
        relativePath: 'battery.sav.conflict-aaaa',
        sha256: 'bbb',
        kind: 'battery_save',
      },
    ],
    { direction: 'push', writable: false, itemRevision: 3 },
  );
  assert.deepEqual(steps, [
    { op: 'skip', relativePath: 'battery.sav', reason: 'same-digest' },
    { op: 'skip', relativePath: 'battery.sav.conflict-aaaa', reason: 'same-digest' },
  ]);
});

test('a mounted folder lists files, hides dotfiles, and refuses a symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-plugin-mount-'));
  const outside = await mkdtemp(join(tmpdir(), 'ecs-plugin-outside-'));
  await mkdir(join(dir, 'snes'));
  await writeFile(join(dir, 'snes', 'game.nes'), 'rom-bytes');
  await writeFile(join(dir, 'battery.sav'), 'save');
  await writeFile(join(dir, '.hidden'), 'nope');
  await symlink(join(outside, 'secret'), join(dir, 'linked'));
  const connector = await openMount({
    id: 'home.library.smb',
    scheme: 'smb',
    root: dir,
    ignoreHidden: true,
    kinds: [{ suffix: '.sav', kind: 'battery_save' }],
  });
  await assert.rejects(connector.list(), (error: PluginError) => error.code === 'path-escape');
  await rm(join(dir, 'linked'));
  const listed = await connector.list();
  assert.deepEqual(
    listed.map((object) => [object.relativePath, object.kind]),
    [
      ['battery.sav', 'battery_save'],
      ['snes/game.nes', 'rom'],
    ],
  );
  const game = listed.find((object) => object.relativePath === 'snes/game.nes');
  if (!game) throw new Error('game missing');
  assert.equal(game.sha256, createHash('sha256').update('rom-bytes').digest('hex'));
  assert.equal(Buffer.from(await connector.read(game, 0, 2)).toString(), 'rom');
  await assert.rejects(connector.read({ ...game, relativePath: '../secret' }, 0, 0), PluginError);
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('S3 signing matches the published empty-body GET vector', () => {
  const signed = signS3({
    method: 'GET',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    query: {},
    region: 'us-east-1',
    accessKeyId: 'EXAMPLEEXAMPLEEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    range: 'bytes=0-9',
    now: new Date('2013-05-24T00:00:00.000Z'),
  });
  assert.match(
    signed.headers.authorization ?? '',
    /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
  );
});

test('a cloud read follows a redirect without forwarding the bearer token', async () => {
  const seen: { url: string; authorization: string | undefined }[] = [];
  const fetch: CloudFetch = async (url, init) => {
    seen.push({ url, authorization: init.headers.authorization });
    if (seen.length === 1) {
      return response(302, '', { location: 'https://cdn.example/file' });
    }
    return response(206, 'abcd');
  };
  const connector = await openConnector(
    {
      directory: '/tmp/unused',
      manifest: parseManifest({
        id: 'home.library.box',
        name: 'Box',
        kind: 'connector',
        version: '1.0.0',
        engine: 'ecs.plugin/1',
        connector: { scheme: 'box', folderId: 'folder-1' },
      }),
    },
    { fetch, secrets: { accessToken: 'box-token' } },
  );
  const bytes = await connector.read(
    { relativePath: 'a.nes', locator: 'file-1', size: 4, sha256: null, kind: 'rom' },
    0,
    3,
  );
  assert.equal(Buffer.from(bytes).toString(), 'abcd');
  assert.equal(seen[1]?.authorization, undefined);
  assert.equal(seen[0]?.authorization, 'Bearer box-token');
});

test('Dropbox list failure does not echo the token', async () => {
  const fetch: CloudFetch = async () => response(401, 'token dropbox-token leaked');
  const connector = await openConnector(
    {
      directory: '/tmp/unused',
      manifest: parseManifest({
        id: 'home.library.dropbox',
        name: 'Dropbox',
        kind: 'connector',
        version: '1.0.0',
        engine: 'ecs.plugin/1',
        connector: { scheme: 'dropbox', prefix: '/library' },
      }),
    },
    { fetch, secrets: { accessToken: 'dropbox-token' } },
  );
  await assert.rejects(connector.list(), (error: PluginError) => {
    assert.equal(error.code, 'cloud-response');
    assert.equal(error.message.includes('dropbox-token'), false);
    return true;
  });
});

test('Google Drive walks a child folder', async () => {
  const fetch: CloudFetch = async (url) => {
    if (url.includes('folder-root')) {
      return response(
        200,
        JSON.stringify({
          files: [
            { id: 'folder-snes', name: 'snes', mimeType: 'application/vnd.google-apps.folder' },
            { id: 'file-root', name: 'readme.txt', size: '4', mimeType: 'text/plain' },
          ],
        }),
      );
    }
    return response(
      200,
      JSON.stringify({
        files: [
          { id: 'file-game', name: 'game.nes', size: '3', mimeType: 'application/octet-stream' },
        ],
      }),
    );
  };
  const connector = await openConnector(
    {
      directory: '/tmp/unused',
      manifest: parseManifest({
        id: 'home.library.drive',
        name: 'Drive',
        kind: 'connector',
        version: '1.0.0',
        engine: 'ecs.plugin/1',
        connector: { scheme: 'googledrive', folderId: 'folder-root' },
      }),
    },
    { fetch, secrets: { accessToken: 'drive-token' } },
  );
  const listed = await connector.list();
  assert.deepEqual(
    listed.map((object) => object.relativePath),
    ['readme.txt', 'snes/game.nes'],
  );
});

test('describing a player does not compile an invalid wasm module', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-plugin-player-'));
  await writeFile(join(dir, 'player.wasm'), Buffer.from([0, 0, 0, 0]));
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify({
      id: 'org.example.player',
      name: 'Player',
      kind: 'player',
      version: '1.0.0',
      engine: 'ecs.plugin/1',
      apps: ['org.example.app'],
      player: { systems: ['com.provenance.nes'], module: 'player.wasm' },
    }),
  );
  const plugin = await loadPlugin(dir);
  const described = await describePlayer(plugin.directory, plugin.manifest);
  assert.equal(described.present, true);
  assert.equal(described.compiled, false);
  await rm(dir, { recursive: true, force: true });
});

test('signer and JIT plans stay inside the apps the plugin claims and never take a password', () => {
  const apps = ['org.provenance-emu.provenance'];
  const signed = planZsign({
    apps,
    bundleId: 'org.provenance-emu.provenance.TEAM',
    ipa: 'in.ipa',
    output: 'out.ipa',
    certificate: 'identity.p12',
    profile: 'app.mobileprovision',
  });
  assert.equal(signed.spawn, false);
  assert.equal(signed.steps[0]?.includes('-p'), false);
  assert.equal(signed.steps[0]?.includes('org.provenance-emu.provenance.TEAM'), true);
  assert.throws(
    () =>
      planZsign({
        apps,
        bundleId: 'org.other.app',
        ipa: 'a',
        output: 'b',
        certificate: 'c',
        profile: 'd',
      }),
    (error: PluginError) => error.code === 'app-not-claimed',
  );
  const jit = planJit({ apps, bundleId: 'org.provenance-emu.provenance' });
  assert.equal(jit.spawn, false);
  assert.equal(
    jit.steps.some((step) => step.includes('org.provenance-emu.provenance')),
    true,
  );
  assert.throws(
    () => planJit({ apps, bundleId: 'org.other.app' }),
    (error: PluginError) => error.code === 'app-not-claimed',
  );
});

test('doctor names a missing credential and not its value', () => {
  const manifest = parseManifest({
    id: 'home.library.s3',
    name: 'S3',
    kind: 'connector',
    version: '1.0.0',
    engine: 'ecs.plugin/1',
    connector: { scheme: 's3', bucket: 'library', region: 'us-east-1', prefix: 'roms/' },
  });
  const report = diagnose(manifest, { secrets: null });
  assert.equal(report.ready, false);
  assert.equal(
    report.lines.some((line) => line.includes('accessKeyId')),
    true,
  );
  assert.equal(
    report.lines.some((line) => line.includes('wJalr')),
    false,
  );
});

test('a custom connector entry is loaded from inside its directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-plugin-entry-'));
  await writeFile(
    join(dir, 'driver.mjs'),
    `export function createConnector() {
      return {
        id: 'home.library.custom',
        scheme: 'custom',
        writable: false,
        async list() {
          return [{ relativePath: 'a.nes', locator: 'a.nes', size: 1, sha256: null, kind: 'rom' }];
        },
        async read() { return new Uint8Array([7]); },
      };
    }`,
  );
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify({
      id: 'home.library.custom',
      name: 'Custom',
      kind: 'connector',
      version: '1.0.0',
      engine: 'ecs.plugin/1',
      entry: 'driver.mjs',
      connector: { scheme: 'custom' },
    }),
  );
  const plugin = await loadPlugin(dir);
  const connector = await openConnector(plugin);
  const listed = await connector.list();
  const file = listed[0];
  if (!file) throw new Error('custom connector listed nothing');
  assert.equal(file.relativePath, 'a.nes');
  assert.equal((await connector.read(file, 0, 0))[0], 7);
  assert.throws(
    () =>
      parseManifest({
        id: 'home.library.custom',
        name: 'Custom',
        kind: 'connector',
        version: '1.0.0',
        engine: 'ecs.plugin/1',
        entry: '../driver.mjs',
        connector: { scheme: 'custom' },
      }),
    (error: PluginError) => error.code === 'invalid-manifest',
  );
  await rm(dir, { recursive: true, force: true });
});
