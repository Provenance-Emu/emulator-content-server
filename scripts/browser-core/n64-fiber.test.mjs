import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const cache = join(homedir(), '.cache/ecs-web-player-build-20261028');
const core = process.env.ECS_N64_CORE ?? join(cache, 'mupen64plus-next');
const sdk = process.env.ECS_N64_EMSDK ?? join(cache, 'emsdk');
const compiler = join(sdk, 'upstream/emscripten/emcc');

test('real Emscripten fibers preserve suspended state and return without leaking stacks', {
  skip: !existsSync(compiler) || !existsSync(join(core, 'libretro-common/include/libco.h')),
}, () => {
  assert.ok(existsSync(join(root, 'n64-fiber.c')), 'N64 Emscripten fiber backend is required');
  const directory = mkdtempSync(join(tmpdir(), 'ecs-n64-fiber-'));
  const env = {
    ...process.env,
    EM_CONFIG: join(sdk, '.emscripten'),
    EMCC_CORES: '2',
    BINARYEN_CORES: '2',
  };
  try {
    const compiled = spawnSync(
      compiler,
      [
        '-O0',
        '-std=c89',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-I',
        join(core, 'libretro-common/include'),
        join(root, 'n64-fiber.c'),
        join(root, 'n64-fiber-lifecycle.c'),
        '-sASYNCIFY=1',
        '-sASSERTIONS=2',
        '-sSTACK_OVERFLOW_CHECK=2',
        '-sENVIRONMENT=node',
        '-sSINGLE_FILE=1',
        '-sEXIT_RUNTIME=1',
        '-o',
        join(directory, 'lifecycle.cjs'),
      ],
      { env, encoding: 'utf8', timeout: 120000 },
    );
    assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
    const executed = spawnSync(process.execPath, [join(directory, 'lifecycle.cjs')], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(executed.status, 0, executed.stderr || executed.error?.message);
    assert.match(executed.stdout, /real N64 fiber lifecycle passed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
