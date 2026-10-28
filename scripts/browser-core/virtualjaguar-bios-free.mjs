import { spawnSync } from 'node:child_process';
/** Pinned-source transformation: omit proprietary boot bytes from the cartridge-only build. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const virtualJaguarPin = 'ffea7893a59dd9b9e6f9b85c51627810338b0778';
export function makeVirtualJaguarBiosFree(directory, gitDirectory = directory) {
  const plans = [];
  const original = (file) => {
    const result = spawnSync('git', ['show', `${virtualJaguarPin}:${file}`], {
      cwd: gitDirectory,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0 || result.error) throw new Error('Pinned source is unavailable');
    return result.stdout;
  };
  const plan = (file, before, after) => {
    const path = join(directory, file);
    const current = readFileSync(path, 'utf8');
    if (current !== before && current !== after)
      throw new Error(`Refusing unrelated source changes: ${file}`);
    plans.push({ path, current, after });
  };
  for (const [file, symbol, size] of [
    ['jagbios.c', 'jaguarBootROM', '0x20000'],
    ['jagbios_m.c', 'jaguarBootROM_M', '0x20000'],
    ['jagcdbios.c', 'jaguarCDBootROM', '0x40000'],
    ['jagdevcdbios.c', 'jaguarDevCDBootROM', '0x40000'],
  ]) {
    const before = original(`src/bios/${file}`);
    const include = before.match(/^#include "[A-Za-z0-9_]+\.h"$/m)?.[0];
    if (!include || !before.includes(`uint8_t ${symbol}[${size}] = {`))
      throw new Error('Unsupported pinned BIOS source');
    // Deliberately do not retain an original byte array in a patch or generated source archive.
    plan(
      `src/bios/${file}`,
      before,
      `/* ECS cartridge-only build: boot ROM intentionally omitted. */\n${include}\nuint8_t ${symbol}[${size}] = {0};\n`,
    );
  }
  const beforeSource = original('libretro.c');
  let source = beforeSource;
  const assignment = /vjs\.useJaguarBIOS\s*=(?!=)[^;]+;/g;
  if ([...source.matchAll(assignment)].length !== 7)
    throw new Error('Unsupported pinned BIOS assignment sites');
  source = source.replace(assignment, 'vjs.useJaguarBIOS = false;');
  const gate = '   environ_cb(RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS, desc);';
  if (source.split(gate).length !== 2) throw new Error('Unsupported pinned content gate');
  source = source.replace(
    gate,
    `   /* This distribution has no boot ROM: only directly bootable cartridges/ABS. */\n   if (!info || is_cd_content || !info->data || info->size < 0x24 ||\n         JaguarCartNeedsBIOS((const uint8_t *)info->data, (uint32_t)info->size))\n   {\n      LOG_ERR("[ECS] BIOS-free build requires a directly bootable cartridge or ABS program\\n");\n      return false;\n   }\n\n${gate}`,
  );
  source = source.replace(
    '   stage_cart_boot_rom();',
    '   /* External and built-in boot ROM staging is disabled in this build. */',
  );
  source = source.replace(
    '"j64|jag|rom|abs|cof|bin|prg|cue|cdi|chd"',
    '"j64|jag|rom|abs|cof|bin|prg"',
  );
  plan('libretro.c', beforeSource, source);
  const beforeOptions = original('libretro_core_options.h');
  let options = beforeOptions;
  for (const key of [
    'virtualjaguar_bios',
    'virtualjaguar_bios_type',
    'virtualjaguar_cd_bios_type',
    'virtualjaguar_cd_boot_mode',
  ]) {
    const entry = new RegExp(`   \\{\\n      "${key}",[\\s\\S]*?\\n   \\},\\n`);
    if (!entry.test(options)) throw new Error(`Unsupported pinned option ${key}`);
    options = options.replace(entry, '');
  }
  options = options.replace(
    '      "How cartridges boot: emulated (HLE) BIOS services or the real Jaguar boot ROM."',
    '      "Cartridge-only build using emulated boot services. No boot ROM is included."',
  );
  plan('libretro_core_options.h', beforeOptions, options);
  // Validate every input before changing any source file. Re-running is harmless.
  for (const { path, current, after } of plans) if (current !== after) writeFileSync(path, after);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3)
    throw new Error('Usage: node virtualjaguar-bios-free.mjs CLEAN_PINNED_CORE');
  makeVirtualJaguarBiosFree(resolve(process.argv[2]));
}
