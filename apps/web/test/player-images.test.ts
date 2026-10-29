import assert from 'node:assert/strict';
import test from 'node:test';
import { pngInfo } from '../src/player/images.js';

const png = () =>
  new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
test('PNG validation rejects partial, oversized and excessive-dimension images before decoding', () => {
  assert.deepEqual(pngInfo(png()), { width: 1, height: 1 });
  assert.throws(() => pngInfo(png().slice(0, 40)), /PNG|image/i);
  assert.throws(() => pngInfo(png(), 20), /limit|size/i);
  const huge = png();
  new DataView(huge.buffer).setUint32(16, 9000);
  assert.throws(() => pngInfo(huge), /dimension|size/i);
});
