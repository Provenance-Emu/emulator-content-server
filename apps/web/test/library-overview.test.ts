import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LibraryOverviewFolder } from '@ecs/client';
import { automaticText, missingCount, overviewTotals } from '../src/lib/library-overview.js';

const folder = (patch: Partial<LibraryOverviewFolder> = {}): LibraryOverviewFolder => ({
  rootId: 'root',
  label: 'Games',
  libraryId: null,
  games: 10,
  withDetails: 8,
  withCover: 6,
  unavailable: 1,
  automatic: { state: 'none' },
  ...patch,
});

test('totals add every folder and missing counts the larger gap', () => {
  assert.deepEqual(
    overviewTotals([folder(), folder({ games: 5, withDetails: 5, withCover: 5, unavailable: 0 })]),
    {
      games: 15,
      withDetails: 13,
      withCover: 11,
      unavailable: 1,
    },
  );
  assert.equal(missingCount(folder()), 4);
  assert.equal(missingCount(folder({ withDetails: 12, withCover: 12 })), 0);
});

test('every automatic state has a plain sentence and never claims work that did not happen', () => {
  assert.match(automaticText(true, folder({ games: 0 })), /Scan this folder/);
  assert.equal(automaticText(false, folder()), 'Automatic matching is off.');
  assert.match(automaticText(true, folder()), /Not checked/);
  assert.match(automaticText(true, folder({ automatic: { state: 'waiting' } })), /Queued/);
  assert.match(
    automaticText(true, folder({ automatic: { state: 'queued' } })),
    /still need review/,
  );
  assert.match(
    automaticText(true, folder({ withDetails: 10, withCover: 10, automatic: { state: 'queued' } })),
    /found automatically/,
  );
  assert.match(
    automaticText(true, folder({ automatic: { state: 'unchanged' } })),
    /Nothing has changed/,
  );
  assert.equal(automaticText(true, folder({ withDetails: 10, withCover: 10 })), 'Nothing missing.');
});
