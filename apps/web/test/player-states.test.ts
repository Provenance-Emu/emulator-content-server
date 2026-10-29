import assert from 'node:assert/strict';
import test from 'node:test';
import {
  stateCompatibility,
  statePath,
  statePreview,
  stateTimestamp,
} from '../src/player/states.js';
import { fixture } from './player-fixture.js';

test('snapshot identity binds both artifact hashes, keeps prior states and pairs only an exact same-item path', () => {
  const f = fixture();
  const first = statePath(f.core),
    second = statePath(f.core);
  assert.notEqual(first, second);
  assert.ok(first.length < 240);
  assert.equal(stateCompatibility(first, f.core), 'compatible');
  assert.ok(stateTimestamp(first));
  assert.equal(stateCompatibility('imported.state', f.core), 'unknown');
  f.core.wasm.sha256 = 'c'.repeat(64);
  assert.equal(stateCompatibility(first, f.core), 'incompatible');
  assert.equal(stateCompatibility('browser-states/v9/invalid.state', f.core), 'incompatible');
  const preview = {
    ...f.manifest.files[0]!,
    id: 'preview',
    kind: 'screenshot',
    relativePath: first + '.png',
  };
  assert.equal(
    statePreview([{ ...preview, relativePath: second + '.png' }, preview], first)?.id,
    'preview',
  );
  assert.equal(statePreview([preview], 'imported.state'), undefined);
});
