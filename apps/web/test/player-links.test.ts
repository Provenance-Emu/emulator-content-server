import assert from 'node:assert/strict';
import test from 'node:test';
import { assetPlayHref, sourcePlayHref } from '../src/player/links.js';
import { fixture } from './player-fixture.js';

test('Play links admit only supported NES content and currently local sources, with encoded IDs', () => {
  const f = fixture();
  const rom = f.manifest.files[0];
  const battery = f.manifest.files[1];
  assert.ok(rom);
  assert.ok(battery);
  assert.equal(assetPlayHref(f.core, f.item, rom), '/play/?item=item&asset=rom');
  assert.equal(assetPlayHref(null, f.item, rom), null);
  assert.equal(
    assetPlayHref(f.core, { ...f.item, systemIdentifier: 'com.provenance.snes' }, rom),
    null,
  );
  assert.equal(assetPlayHref(f.core, f.item, battery), null);
  assert.equal(assetPlayHref(f.core, f.item, { ...rom, relativePath: 'game.zip' }), null);
  assert.equal(sourcePlayHref(f.core, f.source), '/play/?source=source');
  for (const availability of ['evicted', 'offline', 'unknown'])
    assert.equal(sourcePlayHref(f.core, { ...f.source, availability }), null);
  assert.equal(sourcePlayHref(f.core, { ...f.source, systemId: null }), null);
  assert.equal(sourcePlayHref(f.core, { ...f.source, kind: 'battery_save' }), null);
  assert.equal(
    sourcePlayHref(f.core, { ...f.source, id: 'source&item=guess' }),
    '/play/?source=source%26item%3Dguess',
  );
});
