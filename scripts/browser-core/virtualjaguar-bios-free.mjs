import { spawnSync } from 'node:child_process';
/** Pinned-source transformation: retain cartridge/CD HLE without distributing boot ROM bytes. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const virtualJaguarPin = 'ffea7893a59dd9b9e6f9b85c51627810338b0778';
export function virtualJaguarHleSource(beforeSource) {
  let source = beforeSource;
  const assignment = /vjs\.useJaguarBIOS\s*=(?!=)[^;]+;/g;
  if ([...source.matchAll(assignment)].length !== 7)
    throw new Error('Unsupported pinned BIOS assignment sites');
  source = source.replace(assignment, 'vjs.useJaguarBIOS = false;');
  const mode = /vjs\.cdBootMode\s*=(?!=)[^;]+;/g;
  if ([...source.matchAll(mode)].length !== 4)
    throw new Error('Unsupported pinned CD boot-mode sites');
  source = source.replace(mode, 'vjs.cdBootMode = CDBOOT_HLE;');
  const effective = '   effective_cd_boot_mode = vjs.cdBootMode;';
  if (source.split(effective).length !== 2) throw new Error('Unsupported pinned CD boot resolver');
  source = source.replace(effective, '   effective_cd_boot_mode = CDBOOT_HLE;');
  const audio =
    / {3}if \(CDIntfGetNumSessions\(\) == 1\)\n {3}\{[\s\S]*?effective_cd_boot_mode = CDBOOT_BIOS;\n {3}\}/;
  if (!audio.test(source)) throw new Error('Unsupported pinned audio-disc override');
  source = source.replace(
    audio,
    `   if (CDIntfGetNumSessions() == 1)\n   {\n      LOG_ERR("[ECS] Audio-only discs require a separately supplied real CD BIOS; unavailable in this HLE profile\\n");\n      CDIntfCloseImage();\n      return DISC_BOOT_NO_BIOS_FOR_AUDIO;\n   }`,
  );
  const gate = '   environ_cb(RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS, desc);';
  if (source.split(gate).length !== 2) throw new Error('Unsupported pinned content gate');
  source = source.replace(
    gate,
    `   /* CD data discs use the original upstream HLE path. Cartridge boot-ROM-only\n    * programs and no-content BIOS boot remain unavailable in this profile. */\n   if (!info || (!is_cd_content && (!info->data || info->size < 0x24 ||\n         JaguarCartNeedsBIOS((const uint8_t *)info->data, (uint32_t)info->size))))\n   {\n      LOG_ERR("[ECS] Content requires unavailable real boot firmware\\n");\n      return false;\n   }\n\n${gate}`,
  );
  const staging = /^(\s*)stage_(?:cart_boot_rom|cd_bios)\(\);$/gm;
  if ([...source.matchAll(staging)].length !== 3)
    throw new Error('Unsupported pinned firmware staging sites');
  source = source.replace(
    staging,
    '$1(void)0; /* ECS: no embedded or external firmware staging. */',
  );
  return source;
}
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
      `/* ECS HLE build: boot ROM intentionally omitted. */\n${include}\nuint8_t ${symbol}[${size}] = {0};\n`,
    );
  }
  const beforeSource = original('libretro.c');
  const source = virtualJaguarHleSource(beforeSource);
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
    '      "Cartridge and CD data-disc HLE boot services. No boot ROM is included."',
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
