import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { jaguarSmokeAbs, jaguarSmokeCdi } from './generate-smoke-program.mjs';
import { snapshotJaguarBuildSource } from './jaguar-source.mjs';
import { virtualJaguarHleSource } from './virtualjaguar-bios-free.mjs';

function upstreamFixture() {
  return [
    ...Array.from({ length: 7 }, () => '   vjs.useJaguarBIOS = true;'),
    ...Array.from({ length: 4 }, () => '   vjs.cdBootMode = CDBOOT_BIOS;'),
    '   effective_cd_boot_mode = vjs.cdBootMode;',
    '   if (CDIntfGetNumSessions() == 1)\n   {\n      effective_cd_boot_mode = CDBOOT_BIOS;\n   }',
    '   environ_cb(RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS, desc);',
    '   stage_cart_boot_rom();',
    '      stage_cd_bios();',
    '         stage_cd_bios();',
    '   supports = "j64|jag|rom|abs|cof|bin|prg|cue|cdi|chd";',
  ].join('\n');
}

test('HLE wrapper preserves CD dispatch but rejects firmware-only boot and staging', () => {
  const result = virtualJaguarHleSource(upstreamFixture());
  assert.ok(result.includes('(!is_cd_content && (!info->data'));
  assert.ok(!result.includes('!info || is_cd_content'));
  assert.equal([...result.matchAll(/vjs\.useJaguarBIOS = false;/g)].length, 7);
  assert.equal([...result.matchAll(/vjs\.cdBootMode = CDBOOT_HLE;/g)].length, 4);
  assert.ok(result.includes('effective_cd_boot_mode = CDBOOT_HLE;'));
  assert.ok(result.includes('return DISC_BOOT_NO_BIOS_FOR_AUDIO;'));
  assert.ok(!result.includes('effective_cd_boot_mode = CDBOOT_BIOS;'));
  assert.ok(!/stage_(?:cart_boot_rom|cd_bios)\(\);/.test(result));
  assert.ok(result.includes('cue|cdi|chd'));
});

test('HLE wrapper refuses changed upstream firmware, mode, audio and content dispatch sites', () => {
  const source = upstreamFixture();
  for (const fragment of [
    '   vjs.useJaguarBIOS = true;',
    '   vjs.cdBootMode = CDBOOT_BIOS;',
    '   effective_cd_boot_mode = vjs.cdBootMode;',
    'effective_cd_boot_mode = CDBOOT_BIOS;',
    '   environ_cb(RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS, desc);',
    '   stage_cart_boot_rom();',
  ])
    assert.throws(() => virtualJaguarHleSource(source.replace(fragment, '')), /Unsupported pinned/);
});

test('generated CDI carries only our original program in two-session audio-sector layout', () => {
  const disc = jaguarSmokeCdi();
  const footer = disc.subarray(-8);
  assert.equal(footer.readUInt32LE(), 0x80000006);
  const table = disc.length - footer.readUInt32LE(4);
  assert.equal(table, 8 * 2352);
  assert.equal(disc.readUInt16LE(table), 2);
  const payload = Buffer.from(disc.subarray(4 * 2352, 8 * 2352));
  payload.swap16();
  assert.equal(payload.toString('ascii', 0x42, 0x62), 'ATARI APPROVED DATA HEADER ATRI ');
  assert.equal(payload.readUInt32BE(0x62), 0x4000);
  const code = jaguarSmokeAbs().subarray(0x24);
  assert.equal(payload.readUInt32BE(0x66), code.length);
  assert.deepEqual(payload.subarray(0x6a, 0x6a + code.length), code);
});

test('low-footprint source copies validate committed bytes and never copy ignored objects or mutations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-jaguar-source-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '--quiet']);
  await writeFile(join(directory, 'core.c'), 'original committed input\n');
  await writeFile(join(directory, 'skip.c'), 'excluded input\n');
  await symlink('core.c', join(directory, 'link.c'));
  git(['add', '.']);
  git([
    '-c',
    'user.name=Generated',
    '-c',
    'user.email=generated@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'Generated fixture',
  ]);
  const pin = git(['rev-parse', 'HEAD']);
  await writeFile(join(directory, 'core.c'), 'operator mutation\n');
  await writeFile(join(directory, 'untracked.o'), 'untracked object');
  const output = join(directory, 'snapshot');
  snapshotJaguarBuildSource(directory, output, pin, (file) => file === 'skip.c');
  assert.equal(await readFile(join(output, 'core.c'), 'utf8'), 'original committed input\n');
  assert.equal(await readFile(join(output, 'link.c'), 'utf8'), 'original committed input\n');
  assert.equal(await readFile(join(directory, 'core.c'), 'utf8'), 'operator mutation\n');
  await assert.rejects(readFile(join(output, 'untracked.o')));
  await assert.rejects(readFile(join(output, 'skip.c')));
  assert.throws(
    () => snapshotJaguarBuildSource(directory, join(directory, 'wrong'), '0'.repeat(40)),
    /Source pin mismatch/,
  );
});
