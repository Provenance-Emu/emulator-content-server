import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parsePlayerPackage } from '../packages/plugins/dist/src/index.js';
import { packagePlayer } from './browser-core/package-player.mjs';
import {
  addRecoveredPlayerNotices,
  addRecoveredSourceNotices,
  recoveredNoticeFiles,
} from './browser-core/recovered-notices.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const coreIds = [
  'fceumm',
  'prosystem',
  'pcsx-rearmed',
  'virtualjaguar',
  'stella2014',
  'freeintv',
  'atari800',
  'pokemini',
  'potator',
  'sameduck',
  'mednafen-pcfx',
];
async function fixture(t, id = 'mednafen-pcfx') {
  const root = await mkdtemp(join(tmpdir(), 'ecs-recovered-notices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'players', id);
  await mkdir(directory, { recursive: true });
  const resources = new Map([
    ['loader.js', Buffer.from('export default async () => ({ generatedFixture: true });\n')],
    ['core.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])],
    ['configuration.txt', Buffer.from('fixture configuration\n')],
  ]);
  const spec = (file) => ({ file, sha256: digest(resources.get(file)) });
  const manifest = {
    id: `org.libretro.${id}`,
    name: 'Generated fixture',
    kind: 'player',
    version: '1.0.0',
    engine: 'ecs.plugin/1',
    apps: ['org.provenance-emu.provenance'],
    player: {
      systems: ['com.provenance.pcfx'],
      module: 'core.wasm',
      web: {
        profileVersion: 1,
        runtime: 'retroarch-emscripten-esm',
        filesystem: 'memfs',
        threaded: false,
        saveCompletion: 'none',
        contentExtensions: ['chd'],
        maxContentBytes: 536870912,
        buildVersion: 'generated fixture',
        defaultCoreOptions: { fixture_mode: 'test' },
        defaultInputLayout: 'compact',
        systemFilesDirectory: 'firmware',
        loader: spec('loader.js'),
        wasm: spec('core.wasm'),
        assets: [{ name: 'configuration.txt', ...spec('configuration.txt') }],
      },
    },
  };
  await writeFile(join(directory, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [file, bytes] of resources) await writeFile(join(directory, file), bytes);
  return { root, directory, manifest, resources };
}

test('all eleven custom cores retain exact SHA1 grant bytes and only PCFX receives the full IJG materials', async () => {
  for (const id of coreIds) {
    const files = await recoveredNoticeFiles(id);
    const sha1 = files.find((file) => file.file === 'sha1-fpl.txt');
    assert.equal(sha1.sizeBytes, 702);
    assert.equal(sha1.sha256, '2a147c48b8645d808731c27373c4863417162f4f7a562c4bff7a4f86eccb05a2');
    assert.deepEqual(
      sha1.bytes,
      await readFile(new URL('../docs/operations/notices/sha1-fpl.txt', import.meta.url)),
    );
    for (const file of files) {
      assert.match(file.file, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
      assert.equal(file.sha256, digest(file.bytes));
      assert.equal(file.sizeBytes, file.bytes.length);
    }
    const readme = files.find((file) => file.file === 'ijg-v4-README.txt');
    assert.equal(Boolean(readme), id === 'mednafen-pcfx');
    const notices = files.find((file) => file.file === 'recovered-NOTICES.txt').bytes.toString();
    assert.match(notices, new RegExp(id));
    assert.match(notices, /Freeware Public License/);
    const evidence = JSON.parse(
      files.find((file) => file.file === 'recovered-notice-evidence.json').bytes,
    );
    assert.equal(evidence.coreId, id);
    if (readme) {
      assert.equal(readme.sizeBytes, 21128);
      assert.equal(
        readme.sha256,
        'a1c127ce9bb177cfd15354278f745e4020fea5a4e45cb2007d79d335a4d695a9',
      );
      assert.deepEqual(
        readme.bytes,
        await readFile(new URL('../docs/operations/notices/ijg-v4-README.txt', import.meta.url)),
      );
      assert.match(
        notices,
        /This software is based in part on the work of the Independent JPEG Group\./,
      );
      const changes = files.find((file) => file.file === 'ijg-modifications.txt').bytes.toString();
      assert.match(changes, /2007/);
      assert.match(changes, /CONST_BITS\+PASS1_BITS\+1/);
      assert.match(changes, /zero-AC/);
    } else {
      assert.equal(
        files.some((file) => file.file.startsWith('ijg-')),
        false,
      );
    }
  }
  await assert.rejects(recoveredNoticeFiles('unknown-core'), /Unknown buildbot core/);
});

test('notice addition packages full materials while preserving every runtime field and existing byte', async (t) => {
  const { root, directory, manifest, resources } = await fixture(t);
  const added = await addRecoveredPlayerNotices(directory, 'mednafen-pcfx');
  const firstManifest = await readFile(join(directory, 'plugin.json'));
  await addRecoveredPlayerNotices(directory, 'mednafen-pcfx');
  assert.deepEqual(await readFile(join(directory, 'plugin.json')), firstManifest);
  const packaged = parsePlayerPackage(
    await packagePlayer(directory, join(root, 'fixture.ecsplayer')),
  );
  const expected = structuredClone(manifest);
  expected.player.web.assets.push(
    ...added.map(({ file, sha256 }) => ({ name: file, file, sha256 })),
  );
  assert.deepEqual(packaged.manifest, expected);
  for (const [file, bytes] of resources) assert.deepEqual(packaged.files.get(file), bytes);
  for (const file of added) assert.deepEqual(packaged.files.get(file.file), file.bytes);
});

test('conflicting notice files leave the manifest and existing files untouched', async (t) => {
  const { directory } = await fixture(t);
  const manifestBefore = await readFile(join(directory, 'plugin.json'));
  await writeFile(join(directory, 'sha1-fpl.txt'), 'operator-owned different notice');
  await assert.rejects(
    addRecoveredPlayerNotices(directory, 'mednafen-pcfx'),
    /Conflicting recovered notice/,
  );
  assert.deepEqual(await readFile(join(directory, 'plugin.json')), manifestBefore);
  assert.equal(
    await readFile(join(directory, 'sha1-fpl.txt'), 'utf8'),
    'operator-owned different notice',
  );
  await assert.rejects(readFile(join(directory, 'ijg-v4-README.txt')), { code: 'ENOENT' });
});

test('manifest asset conflicts and wrong core identity fail before writing notice files', async (t) => {
  const { directory, manifest } = await fixture(t);
  await assert.rejects(addRecoveredPlayerNotices(directory, 'prosystem'), /Player identity/);
  manifest.player.web.assets.push({
    name: 'sha1-fpl.txt',
    file: 'existing.txt',
    sha256: 'a'.repeat(64),
  });
  const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(join(directory, 'plugin.json'), bytes);
  await assert.rejects(
    addRecoveredPlayerNotices(directory, 'mednafen-pcfx'),
    /Conflicting recovered notice asset/,
  );
  assert.deepEqual(await readFile(join(directory, 'plugin.json')), bytes);
  await assert.rejects(readFile(join(directory, 'sha1-fpl.txt')), { code: 'ENOENT' });
});

test('source sidecars retain all applicable materials and reject conflicting files or redirected directories', async (t) => {
  const { root } = await fixture(t, 'virtualjaguar');
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'generated.c'), 'int fixture = 1;\n');
  const files = await addRecoveredSourceNotices(source, 'virtualjaguar');
  await addRecoveredSourceNotices(source, 'virtualjaguar');
  for (const file of files)
    assert.deepEqual(await readFile(join(source, 'notices', file.file)), file.bytes);
  assert.equal(await readFile(join(source, 'generated.c'), 'utf8'), 'int fixture = 1;\n');
  await writeFile(join(source, 'notices', 'sha1-fpl.txt'), 'conflicting notice');
  await assert.rejects(
    addRecoveredSourceNotices(source, 'virtualjaguar'),
    /Conflicting recovered notice/,
  );
  const redirected = join(root, 'redirected');
  await mkdir(redirected);
  await symlink(join(source, 'notices'), join(redirected, 'notices'));
  await assert.rejects(addRecoveredSourceNotices(redirected, 'virtualjaguar'), /regular directory/);
});

test('notice files cannot redirect writes through existing symlinks', async (t) => {
  const { root, directory } = await fixture(t);
  const original = join(root, 'original.txt');
  await writeFile(original, 'unrelated original bytes');
  await symlink(original, join(directory, 'sha1-fpl.txt'));
  await assert.rejects(addRecoveredPlayerNotices(directory, 'mednafen-pcfx'), /regular file/);
  assert.equal(await readFile(original, 'utf8'), 'unrelated original bytes');
});

test('regular and sanitized source archive entry points package full notices with original source bytes', async (t) => {
  const { packageBuildbotSource } = await import('./browser-core/buildbot.mjs');
  assert.equal(typeof packageBuildbotSource, 'function');
  const { spawnSync } = await import('node:child_process');
  const { root } = await fixture(t);
  const runTar = (args) => {
    const result = spawnSync('tar', args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  for (const id of ['mednafen-pcfx', 'virtualjaguar']) {
    const input = join(root, `${id}-original`);
    await mkdir(input);
    await writeFile(join(input, 'generated.c'), 'int generated_source_fixture = 1;\n');
    let source = input;
    let options;
    if (id === 'virtualjaguar') {
      const sanitizedArchive = join(root, 'sanitized-original.tar.gz');
      runTar(['-czf', sanitizedArchive, '-C', input, '.']);
      source = join(root, 'sanitized-source-with-notices');
      options = { sanitizedArchive };
    }
    const archive = join(root, `${id}.source.tar.gz`);
    await packageBuildbotSource(source, archive, id, options);
    const extracted = join(root, `${id}-extracted`);
    await mkdir(extracted);
    runTar(['-xzf', archive, '-C', extracted]);
    assert.equal(
      await readFile(join(extracted, 'generated.c'), 'utf8'),
      'int generated_source_fixture = 1;\n',
    );
    assert.equal(
      digest(await readFile(join(extracted, 'notices/sha1-fpl.txt'))),
      '2a147c48b8645d808731c27373c4863417162f4f7a562c4bff7a4f86eccb05a2',
    );
    if (id === 'mednafen-pcfx')
      assert.equal(
        digest(await readFile(join(extracted, 'notices/ijg-v4-README.txt'))),
        'a1c127ce9bb177cfd15354278f745e4020fea5a4e45cb2007d79d335a4d695a9',
      );
    else
      await assert.rejects(readFile(join(extracted, 'notices/ijg-v4-README.txt')), {
        code: 'ENOENT',
      });
  }
});

test('a named pipe occupying a notice filename fails promptly without reading from it', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { directory } = await fixture(t);
  const created = spawnSync('mkfifo', [join(directory, 'sha1-fpl.txt')], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { addRecoveredPlayerNotices } from ${JSON.stringify(new URL('./browser-core/recovered-notices.mjs', import.meta.url).href)}; const deadline = setTimeout(() => { console.error('Notice operation timed out'); process.exit(2); }, 5000); try { await addRecoveredPlayerNotices(${JSON.stringify(directory)}, 'mednafen-pcfx'); } finally { clearTimeout(deadline); }`,
    ],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular file/);
});

test('source archive standalone recipe reproduces the complete package including existing runtime assets', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { root, directory, resources } = await fixture(t);
  await addRecoveredPlayerNotices(directory, 'mednafen-pcfx');
  const packageBytes = await packagePlayer(directory, join(root, 'original.ecsplayer'));
  const source = join(root, 'corresponding-source');
  const rebuilt = join(root, 'rebuilt-player');
  await mkdir(source);
  await mkdir(rebuilt);
  for (const [file, bytes] of resources) await writeFile(join(rebuilt, file), bytes);
  await addRecoveredSourceNotices(source, 'mednafen-pcfx', { packageBytes });
  await addRecoveredSourceNotices(source, 'mednafen-pcfx', { packageBytes });
  const output = join(root, 'reproduced.ecsplayer');
  const run = (destination) =>
    spawnSync(process.execPath, [join(source, 'REPACKAGE-NOTICES.mjs'), rebuilt, destination], {
      encoding: 'utf8',
      timeout: 20000,
    });
  const result = run(output);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(output), packageBytes);
  await writeFile(join(rebuilt, 'configuration.txt'), 'altered existing asset');
  const altered = run(join(root, 'must-not-exist.ecsplayer'));
  assert.notEqual(altered.status, 0);
  assert.match(altered.stderr, /Rebuild\/notice bytes differ/);
  await assert.rejects(readFile(join(root, 'must-not-exist.ecsplayer')), { code: 'ENOENT' });
  const occupied = run(output);
  assert.notEqual(occupied.status, 0);
  assert.deepEqual(await readFile(output), packageBytes);
});

test('notice additions respect the manifest asset limit before changing any files', async (t) => {
  const { directory, manifest } = await fixture(t);
  manifest.player.web.assets = Array.from({ length: 14 }, (_, index) => ({
    name: `fixture-${index}.txt`,
    file: `fixture-${index}.txt`,
    sha256: 'a'.repeat(64),
  }));
  const original = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(join(directory, 'plugin.json'), original);
  await assert.rejects(addRecoveredPlayerNotices(directory, 'mednafen-pcfx'), /at most 16 assets/);
  assert.deepEqual(await readFile(join(directory, 'plugin.json')), original);
  await assert.rejects(readFile(join(directory, 'sha1-fpl.txt')), { code: 'ENOENT' });
});

test('release artifact sidecars stay flat for the release upload glob', async (t) => {
  const { addRecoveredArtifactNotices } = await import('./browser-core/recovered-notices.mjs');
  assert.equal(typeof addRecoveredArtifactNotices, 'function');
  const { root } = await fixture(t);
  const artifacts = join(root, 'artifacts');
  await mkdir(artifacts);
  const files = await addRecoveredArtifactNotices(artifacts, 'mednafen-pcfx');
  await addRecoveredArtifactNotices(artifacts, 'mednafen-pcfx');
  for (const { file, bytes } of files)
    assert.deepEqual(await readFile(join(artifacts, file)), bytes);
  await assert.rejects(readFile(join(artifacts, 'notices', 'sha1-fpl.txt')), { code: 'ENOENT' });
});
