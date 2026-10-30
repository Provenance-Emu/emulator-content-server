import assert from 'node:assert/strict';
import test from 'node:test';
import { planCue } from '../src/player/cue.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const cue = bytes(
  'REM SESSION 01\nFILE "../tracks/Track One.bin" BINARY\n TRACK 01 AUDIO\n INDEX 01 00:00:00\nREM SESSION 02\nFILE "../tracks/Track Two.bin" BINARY\n TRACK 02 AUDIO\n INDEX 01 00:00:00\n',
);
const members = [
  { id: 'cue', relativePath: 'disc/game.cue', size: cue.length },
  { id: 'one', relativePath: 'tracks/Track One.bin', size: 2352 },
  { id: 'two', relativePath: 'tracks/Track Two.bin', size: 4704 },
];
test('CUE stages contained nested binary members with portable rewritten references and preserved sessions', () => {
  const plan = planCue(cue, 'disc/game.cue', members, 1024 * 1024);
  assert.deepEqual(plan.files, [
    { id: 'one', path: '/ecs/content/track-000.bin', size: 2352 },
    { id: 'two', path: '/ecs/content/track-001.bin', size: 4704 },
  ]);
  const text = new TextDecoder().decode(plan.content);
  assert.match(text, /FILE "track-000.bin" BINARY/);
  assert.match(text, /REM SESSION 02/);
  assert.ok(!text.includes('../tracks'));
});
test('multiple tracks in one BIN download it once', () => {
  const plan = planCue(
    bytes(
      'FILE "TRACK.BIN" BINARY\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nFILE "track.bin" BINARY\nTRACK 02 AUDIO\nINDEX 01 00:01:00',
    ),
    'game.cue',
    [{ id: 'track', relativePath: 'track.bin', size: 4704 }],
    10000,
  );
  assert.equal(plan.files.length, 1);
  assert.equal(new TextDecoder().decode(plan.content).match(/track-000.bin/g)?.length, 2);
});
for (const reference of [
  '/etc/file.bin',
  '../../file.bin',
  'C:\\file.bin',
  'https://example.com/file.bin',
  'file\0.bin',
]) {
  test(`CUE rejects an unsafe reference ${JSON.stringify(reference)}`, () => {
    assert.throws(() =>
      planCue(bytes(`FILE "${reference}" BINARY\nTRACK 01 AUDIO`), 'game.cue', members, 10000),
    );
  });
}
test('CUE rejects missing, ambiguous, evicted and unsupported files before collection', () => {
  const simple = bytes('FILE "track.bin" BINARY\nTRACK 01 AUDIO');
  assert.throws(() => planCue(simple, 'game.cue', [], 10000), /missing/i);
  assert.throws(
    () =>
      planCue(
        simple,
        'game.cue',
        [
          { id: 'a', relativePath: 'track.bin', size: 1 },
          { id: 'b', relativePath: 'TRACK.bin', size: 1 },
        ],
        10000,
      ),
    /ambiguous/i,
  );
  assert.throws(
    () =>
      planCue(
        simple,
        'game.cue',
        [{ id: 'a', relativePath: 'track.bin', size: 1, availability: 'evicted' }],
        10000,
      ),
    /available/i,
  );
  assert.throws(
    () => planCue(bytes('FILE "track.bin" WAVE\nTRACK 01 AUDIO'), 'game.cue', members, 10000),
    /BINARY/,
  );
});
test('CUE bounds descriptor bytes, unique members, sizes and aggregate memory', () => {
  assert.throws(() => planCue(new Uint8Array(65537), 'game.cue', [], 100000), /descriptor/i);
  assert.throws(() => planCue(cue, 'disc/game.cue', members, 7000), /limit/i);
  const simple = bytes('FILE "track.bin" BINARY\nTRACK 01 AUDIO');
  for (const size of [0, -1, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => planCue(simple, 'game.cue', [{ id: 'a', relativePath: 'track.bin', size }], 10000),
      /size/i,
    );
  assert.throws(
    () =>
      planCue(
        bytes(
          Array.from({ length: 128 }, (_, n) => `FILE "${n}.bin" BINARY\nTRACK 01 AUDIO`).join(
            '\n',
          ),
        ),
        'game.cue',
        Array.from({ length: 128 }, (_, n) => ({
          id: String(n),
          relativePath: `${n}.bin`,
          size: 1,
        })),
        100000,
      ),
    /many/i,
  );
});
