import assert from 'node:assert/strict';
import test from 'node:test';
import type { SourceMatchRecord } from '@ecs/domain';
import { coverRecord, planDetails } from '../src/icloud-details.js';

const record = (
  kind: 'metadata' | 'artwork',
  providerId: string,
  metadata: Record<string, string> = {},
): SourceMatchRecord => ({
  id: `${providerId}:${kind}:generated`,
  providerId,
  kind,
  ...(kind === 'artwork' ? { artworkRole: 'front' as const } : {}),
  title: metadata.title ?? 'Generated',
  confidence: 'name',
  metadata,
  originKind: null,
  contentAvailable: kind === 'artwork',
  contentType: kind === 'artwork' ? 'image/png' : null,
  fileName: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

test('a cover from the app only goes where there is no cover', () => {
  const rom = {
    systemIdentifier: null,
    filename: null,
    size: null,
    title: null,
    hasCustomCover: true,
  };
  assert.equal(planDetails(rom, [], 'File').wantsCover, true);
  // A cover found by the server may be one the owner picked from a provider: it stays.
  for (const provider of ['org.generated.matcher', 'manual', 'provenance'])
    assert.equal(
      planDetails(rom, [record('artwork', provider)], 'File').wantsCover,
      false,
      provider,
    );
  assert.equal(planDetails({ ...rom, hasCustomCover: false }, [], 'File').wantsCover, false);
});

test('a game known only by name is left for the server to look up', () => {
  const named = { systemIdentifier: null, filename: null, size: null, title: 'Only a title' };
  assert.equal(planDetails(named, [], 'File').record, null);
  const described = planDetails({ ...named, details: { developer: 'Generated Dev' } }, [], 'File');
  assert.deepEqual(
    [described.record?.providerId, described.record?.title, described.record?.metadata.developer],
    ['provenance', 'Only a title', 'Generated Dev'],
  );
});

test('what the app says is cleaned before it is kept', () => {
  const plan = planDetails(
    {
      systemIdentifier: null,
      filename: null,
      size: null,
      title: '  A\u0000 title\u0007 ',
      details: {
        description: `line\u0001 one ${'x'.repeat(3000)}`,
        year: 'sometime in 1994',
        developer: `${'d'.repeat(250)}`,
        genre: '   ',
      },
    },
    [],
    'File',
  );
  assert.equal(plan.record?.title, 'A title');
  assert.equal(plan.record?.metadata.year, undefined, 'a year is four digits or nothing');
  assert.equal(plan.record?.metadata.genre, undefined);
  assert.equal(plan.record?.metadata.developer?.length, 200);
  assert.equal([...(plan.record?.metadata.description ?? '')].length, 2000);
  assert.ok(!plan.record?.metadata.description?.includes('\u0001'));
});

test('filling a record adds only what is missing and keeps its title and provider', () => {
  const current = record('metadata', 'org.generated.matcher', {
    title: 'Server title',
    developer: 'Server Dev',
  });
  const rom = {
    systemIdentifier: null,
    filename: null,
    size: null,
    title: 'App title',
    details: { developer: 'App Dev', publisher: 'App Pub' },
  };
  const filled = planDetails(rom, [current], 'File').record;
  assert.deepEqual(
    [filled?.providerId, filled?.title, filled?.metadata.developer, filled?.metadata.publisher],
    ['org.generated.matcher', 'Server title', 'Server Dev', 'App Pub'],
  );
  assert.notEqual(filled?.id, current.id, 'a new identifier, or the save would change nothing');
  // Nothing left to add: nothing to save. And a record typed here is never touched.
  assert.equal(planDetails(rom, [filled as SourceMatchRecord], 'File').record, null);
  assert.equal(
    planDetails(rom, [record('metadata', 'manual', { title: 'Typed' })], 'File').record,
    null,
  );
});

test('only a real image within the limit is a cover', () => {
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from('generated'),
  ]);
  assert.equal(coverRecord(png, 'Game')?.contentType, 'image/png');
  assert.equal(coverRecord(png, 'Game')?.providerId, 'provenance');
  assert.equal(coverRecord(Buffer.from('not an image'), 'Game'), null);
  assert.equal(coverRecord(Buffer.alloc(0), 'Game'), null);
});
