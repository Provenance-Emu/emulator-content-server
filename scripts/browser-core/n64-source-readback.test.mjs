import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as recipe from './n64-source.mjs';

const cache = join(homedir(), '.cache/ecs-web-player-build-20261028');
const core = process.env.ECS_N64_CORE ?? join(cache, 'mupen64plus-next');
const sdk = process.env.ECS_N64_EMSDK ?? join(cache, 'emsdk');
const compiler = join(sdk, 'upstream/emscripten/em++');
const contextPath = 'GLideN64/src/Graphics/OpenGLContext/opengl_ContextImpl.cpp';

test('real compiled Emscripten color-reader factory selects direct ReadPixels without mapped reads', {
  skip: !existsSync(compiler) || !existsSync(join(core, contextPath)),
}, () => {
  assert.equal(
    typeof recipe.patchN64ReadbackSource,
    'function',
    'WebGL readback selection patch is required',
  );
  const directory = mkdtempSync(join(tmpdir(), 'ecs-n64-readback-'));
  try {
    const source = join(directory, 'context.cpp');
    const original = readFileSync(join(core, contextPath));
    const includes = [
      'custom',
      'custom/mupen64plus-core',
      'custom/GLideN64',
      'GLideN64/src',
      'GLideN64/src/osal',
      'GLideN64/src/inc',
      'GLideN64/src/Graphics/OpenGLContext',
      'mupen64plus-core/src',
      'mupen64plus-core/src/api',
      'libretro-common/include',
      'libretro',
    ].flatMap((path) => ['-I', join(core, path)]);
    for (const target of ['before-fix', 'web']) {
      writeFileSync(source, original);
      if (target === 'web') recipe.patchN64ReadbackSource(source);
      const output = join(directory, `${target}.ll`);
      const result = spawnSync(
        compiler,
        [
          '-std=gnu++11',
          '-O0',
          '-S',
          '-emit-llvm',
          '-DMUPENPLUSAPI',
          '-D__LIBRETRO__',
          '-DHAVE_OPENGLES',
          '-DHAVE_OPENGLES3',
          '-DGLES3',
          '-DEGL',
          ...includes,
          source,
          '-o',
          output,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            EM_CONFIG: join(sdk, '.emscripten'),
            EMCC_CORES: '2',
            BINARYEN_CORES: '2',
          },
          timeout: 120000,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const factory = readFileSync(output, 'utf8').match(
        /^define[^\n]*@[^ \n]*createColorBufferReader[^\n]*[\s\S]*?^}/m,
      )?.[0];
      assert.ok(factory, 'actual ContextImpl factory must be present in LLVM IR');
      assert.match(factory, /ColorBufferReaderWithReadPixels/);
      if (target === 'web')
        assert.doesNotMatch(factory, /ColorBufferReaderWith(?:PixelBuffer|BufferStorage)/);
      else assert.match(factory, /ColorBufferReaderWithPixelBuffer/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
