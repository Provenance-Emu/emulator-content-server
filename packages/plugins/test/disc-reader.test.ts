import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  type IdentificationPlugin,
  type IdentificationRequest,
  identifyRom,
} from '../src/rom-identification.js';

const empty = () => ({
  version: 1 as const,
  pluginIds: [],
  hashes: [],
  identifiers: [],
  names: [],
  warnings: [],
});
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ecs-disc-reader-')));
  await writeFile(join(directory, 'game.cue'), 'cue');
  await writeFile(join(directory, 'track.bin'), Buffer.from([1, 2, 3, 4]));
  const request: IdentificationRequest = {
    path: join(directory, 'game.cue'),
    name: 'game.cue',
    systemId: null,
    size: 3,
    media: {
      entry: 'game.cue',
      members: [
        { name: 'game.cue', path: join(directory, 'game.cue'), size: 3 },
        { name: 'track.bin', path: join(directory, 'track.bin'), size: 4 },
      ],
    },
  };
  return { directory, request, close: () => rm(directory, { recursive: true, force: true }) };
}
test('member reader is allowlisted, range bounded and does not turn an arbitrary path into a read', async () => {
  const f = await fixture();
  try {
    let checked = false;
    const plugin: IdentificationPlugin = {
      id: 'org.test.member',
      supports: () => true,
      async identify(_request, reader) {
        assert.ok(reader.readMember);
        assert.deepEqual([...(await reader.readMember('track.bin', 1, 2))], [2, 3]);
        await assert.rejects(reader.readMember('../outside.bin', 0, 1), /member/);
        await assert.rejects(reader.readMember('track.bin', 3, 2), /range/);
        await assert.rejects(reader.readMember('track.bin', 0, 1024 * 1024 + 1), /range/);
        checked = true;
        return empty();
      },
    };
    await identifyRom(f.request, undefined, [plugin]);
    assert.ok(checked, 'The plugin must complete all member boundary assertions');
  } finally {
    await f.close();
  }
});
test('a track changing during identification invalidates all facts', async () => {
  const f = await fixture();
  try {
    const plugin: IdentificationPlugin = {
      id: 'org.test.member',
      supports: () => true,
      async identify(_request, reader) {
        assert.ok(reader.readMember);
        await reader.readMember('track.bin', 0, 4);
        await writeFile(join(f.directory, 'track.bin'), Buffer.from([4, 3, 2, 1]));
        return empty();
      },
    };
    await assert.rejects(identifyRom(f.request, undefined, [plugin]), /source-changed/);
  } finally {
    await f.close();
  }
});
test('member symlinks and duplicate/incorrect entry manifests fail before plugin work', async () => {
  const f = await fixture();
  try {
    await symlink(join(f.directory, 'track.bin'), join(f.directory, 'alias.bin'));
    assert.ok(f.request.media);
    await assert.rejects(
      identifyRom({
        ...f.request,
        media: {
          ...f.request.media,
          members: [
            ...f.request.media.members,
            { name: 'alias.bin', path: join(f.directory, 'alias.bin'), size: 4 },
          ],
        },
      }),
    );
    const first = f.request.media.members[0];
    assert.ok(first);
    await assert.rejects(
      identifyRom({
        ...f.request,
        media: { ...f.request.media, members: [...f.request.media.members, first] },
      }),
    );
    await assert.rejects(
      identifyRom({ ...f.request, media: { ...f.request.media, entry: 'not-the-anchor.cue' } }),
    );
  } finally {
    await f.close();
  }
});
