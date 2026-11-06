import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('Jaguar rebuild rejects changed resources before publishing output and records deterministic build inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'ecs-jag-rebuild-'));
  try {
    const source = join(root, 'source'),
      bin = join(root, 'bin'),
      output = join(root, 'output');
    mkdirSync(bin);
    mkdirSync(join(source, 'frontend'), { recursive: true });
    mkdirSync(join(source, 'virtualjaguar/src/bios'), { recursive: true });
    mkdirSync(join(source, 'virtualjaguar/scripts'));
    for (const file of ['jagbios.c', 'jagbios_m.c', 'jagcdbios.c', 'jagdevcdbios.c'])
      writeFileSync(
        join(source, 'virtualjaguar/src/bios', file),
        '/* ECS HLE build: boot ROM intentionally omitted. */\n#include "generated.h"\nuint8_t generated[0x10] = {0};\n',
      );
    writeFileSync(
      join(source, 'virtualjaguar/scripts/build-id.sh'),
      "#!/bin/sh\nprintf 'ffea789-dirty\\n'\n",
    );
    writeFileSync(
      join(source, 'ECS-BUILD.json'),
      JSON.stringify({
        frontendPin: '4d4bfc0fbaacca30d433e5c11b0b2b5242141b66',
        corePin: 'ffea7893a59dd9b9e6f9b85c51627810338b0778',
        sdk: '3.1.46',
      }),
    );
    writeFileSync(
      join(bin, 'emcc'),
      '#!/bin/sh\necho "emcc version 3.1.46 (19607820c447a13fd8d0b7680c56148427d6e1b8)"\n',
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, 'emmake'),
      `#!${process.execPath}\nimport {writeFileSync,appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(join(root, 'calls'))},JSON.stringify({args:process.argv.slice(2),epoch:process.env.SOURCE_DATE_EPOCH})+'\\n');\nwriteFileSync('virtualjaguar_libretro_emscripten.bc','generated');\nwriteFileSync('virtualjaguar_libretro.js','generated');\nwriteFileSync('virtualjaguar_libretro.wasm','generated');\n`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./rebuild-jaguar-source.mjs', import.meta.url)), source, output],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Rebuilt artifact differs/);
    assert.throws(() => readFileSync(join(output, 'loader.js')), /ENOENT/);
    const calls = readFileSync(join(root, 'calls'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(calls.every((call) => call.epoch === '1793145600'));
    assert.ok(calls.at(-1).args.includes('GIT_VERSION='));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
