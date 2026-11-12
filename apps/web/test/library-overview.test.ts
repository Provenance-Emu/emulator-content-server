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
  assert.equal(automaticText(true, folder({ games: 0 })), 'No indexed games yet.');
  assert.equal(automaticText(false, folder()), 'Automatic lookup is off.');
  assert.match(automaticText(true, folder({ automatic: { state: 'waiting' } })), /queued/);
  assert.match(
    automaticText(
      true,
      folder({ automatic: { state: 'queued', jobState: 'running', processed: 2, total: 5 } }),
    ),
    /2 of 5 checked/,
  );
  assert.match(
    automaticText(true, folder({ automatic: { state: 'queued', jobState: 'interrupted' } })),
    /Lookup stopped/,
  );
  assert.match(
    automaticText(true, folder({ automatic: { state: 'unchanged', providerFailures: 3 } })),
    /failed for 3 games/,
  );
  assert.match(
    automaticText(true, folder({ automatic: { state: 'unchanged' } })),
    /scheduled retry/,
  );
  assert.equal(
    automaticText(true, folder({ withDetails: 10, withCover: 10 })),
    'All games have details and a cover.',
  );
});
