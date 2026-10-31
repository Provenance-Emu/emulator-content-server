import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebPlayerDescriptor } from '@ecs/client';
import { verifiedInputBuild } from '../src/player/input-model.js';

test('source cores enable the native input bridge only for the qualified binary pairs', () => {
  for (const [id, loader, wasm] of [
    [
      'mupen64plus-next',
      '6db1e6fd05fbb883640eb4041bfdcdcf4353f958417c6f3aa1d350aa9933a5eb',
      'f636955f81624090048332642160c16c7f6525df1868bb867f57d4239f1315f9',
    ],
    [
      'pokemini',
      'cf903a0a6c7482e7db633334c6e55e8b371522dfa48016c8514faa37280dcdfd',
      'f318fb9c4294db8c945af4fdeaf980371151d6ce0a48e1ddb717d82f042e443a',
    ],
    [
      'sameduck',
      '9f99c8603f17664a1a635ddccb0acc89407f8ef30f9ed239c36e1f9710fb4f63',
      'c2ca666de2dcb066fa42dad6c3d717466acee4ed785b13877a4b9a33da8f033e',
    ],
    [
      'mednafen-pcfx',
      'a6a89fe471d2f0f54dc0b500f01bbd6b8265623f9b30548d2ccc2b819780c4f6',
      '1d2b7aef7b3bf7a3fe3d8c752fdfe933fe73e143f8e8716e237190823e133d57',
    ],
  ]) {
    const core = {
      id: `org.libretro.${id}`,
      runtime: 'retroarch-emscripten-esm',
      loader: { sha256: loader },
      wasm: { sha256: wasm },
    } as WebPlayerDescriptor;
    assert.equal(verifiedInputBuild(core), true);
    assert.equal(
      verifiedInputBuild({ ...core, wasm: { ...core.wasm, sha256: '0'.repeat(64) } }),
      false,
    );
    assert.equal(
      verifiedInputBuild({ ...core, loader: { ...core.loader, sha256: '0'.repeat(64) } }),
      false,
    );
  }
});
