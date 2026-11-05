import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { groupDiscs } from '../src/disc-groups.js';
import type { ScannedFile } from '../src/scan.js';

const row = (relativePath: string): ScannedFile => ({
  relativePath,
  displayName: relativePath,
  size: 1,
  blocks: 1,
  kind: 'rom',
  systemId: null,
  availability: 'local',
});
test('CUE resolves unique filename casing to the actual indexed member', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ecs-disc-case-')));
  try {
    await writeFile(join(root, 'Game.cue'), 'FILE "track.bin" BINARY\nTRACK 01 AUDIO\n');
    const files = [row('Game.cue'), row('Track.BIN')];
    await groupDiscs(root, files);
    assert.equal(files[0]?.groupError, null);
    assert.deepEqual(files[0]?.groupMembers, ['Game.cue', 'Track.BIN']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('CUE casing fallback rejects ambiguous members and never resolves traversal', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ecs-disc-case-')));
  try {
    await writeFile(join(root, 'Game.cue'), 'FILE "track.bin" BINARY\nTRACK 01 AUDIO\n');
    const files = [row('Game.cue'), row('Track.BIN'), row('TRACK.bin')];
    await groupDiscs(root, files);
    assert.ok(files[0]?.groupError);
    await writeFile(join(root, 'Game.cue'), 'FILE "../track.bin" BINARY\nTRACK 01 AUDIO\n');
    await groupDiscs(root, files);
    assert.ok(files[0]?.groupError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
