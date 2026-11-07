import assert from 'node:assert/strict';
import test from 'node:test';
import { assetPlayHref, playerReturnHref, sourcePlayHref } from '../src/player/links.js';
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
  assert.equal(
    assetPlayHref(f.core, f.item, { ...rom, relativePath: 'game.zip' }),
    '/play/?item=item&asset=rom',
  );
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

test('player return destinations stay on the local library route', () => {
  const origin = 'https://library.example';
  assert.equal(
    playerReturnHref('/ui/?library=arcade&search=quiet', origin),
    '/ui/?library=arcade&search=quiet',
  );
  for (const value of [
    null,
    '',
    '//other.example/ui/',
    'https://other.example/ui/',
    'javascript:alert(1)',
    '/ui/../api/v1/users',
    '/play/',
    '/ui/game',
    '/ui/\\other.example',
  ]) {
    assert.equal(playerReturnHref(value, origin), '/ui/');
  }
});
