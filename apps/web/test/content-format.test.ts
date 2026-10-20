import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availabilityLabel,
  entryKey,
  kindLabel,
  saveGroups,
  systemLabel,
} from '../src/lib/content-format.js';
import { entry, file } from './library-browser-fixture.js';

test('formatting preserves unknown identifiers, distinguishes entity IDs, and groups every save copy', () => {
  assert.equal(entryKey(entry('item', 'same')), 'item:same');
  assert.equal(entryKey(entry('source', 'same')), 'source:same');
  assert.equal(kindLabel('battery_save'), 'Battery save');
  assert.equal(kindLabel('extension_kind'), 'extension_kind');
  assert.equal(systemLabel(null), 'Unknown system');
  assert.equal(systemLabel('unknown'), 'Unknown system');
  assert.equal(systemLabel('com.provenance.nes'), 'nes');
  assert.equal(systemLabel('vendor.other'), 'vendor.other');
  assert.equal(
    systemLabel('com.provenance.nes', [
      { identifier: 'com.provenance.nes', name: 'Nintendo Entertainment System' },
    ]),
    'Nintendo Entertainment System',
  );
  assert.equal(availabilityLabel('offline'), 'Disk offline');
  assert.equal(availabilityLabel('future'), 'future');
  const groups = saveGroups([
    file('copy', 'live'),
    file(),
    { ...file('state'), kind: 'save_state', relativePath: 'folder/save.sav' },
    { ...file('rom'), kind: 'rom' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.live?.id, 'live');
  assert.deepEqual(
    groups[0]?.copies.map((f) => f.id),
    ['copy'],
  );
  assert.equal(groups[1]?.live?.id, 'state');
});

test('unknown labels cannot resolve object prototype properties', () => {
  assert.equal(kindLabel('constructor'), 'constructor');
  assert.equal(availabilityLabel('__proto__'), '__proto__');
});
