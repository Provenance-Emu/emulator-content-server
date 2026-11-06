import assert from 'node:assert/strict';
import test from 'node:test';
import { readShellLocation, shellLocationSearch } from '../src/lib/shell-navigation.js';

test('library and contextual settings destinations survive URL round trips', () => {
  const location = {
    libraryId: 'library one',
    rootId: 'folder/one',
    unassigned: false,
    settings: 'emulators' as const,
    settingsLibraryId: 'library one',
  };
  assert.deepEqual(readShellLocation(shellLocationSearch(location)), location);
});

test('unknown sections and oversized identifiers fall back to the collection overview', () => {
  assert.deepEqual(readShellLocation(`?settings=unknown&library=${'x'.repeat(600)}`), {
    libraryId: '',
    rootId: '',
    unassigned: false,
    settings: null,
    settingsLibraryId: '',
  });
});

test('library scope wins over unassigned scope and route output contains only destination fields', () => {
  const location = readShellLocation('?library=arcade&unassigned=1&settings=devices&token=private');
  assert.equal(location.unassigned, false);
  assert.equal(shellLocationSearch(location), '?library=arcade&settings=devices');
  assert.equal(shellLocationSearch(readShellLocation('')), '');
});
