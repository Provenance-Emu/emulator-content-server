import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  blobPath,
  createChdProvider,
  FileContentReader,
  openVirtualEntry,
  VirtualProviderRegistry,
} from '../src/index.js';

const executable = process.env.ECS_CHDMAN_PATH;
const native = promisify(execFile);
function noisy(length: number, seed = 123456789): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed & 255;
  }
  return bytes;
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('configured native CHD round trips generated DVD and all four CD modes with mixed offsets', {
  skip: executable === undefined ? 'Set ECS_CHDMAN_PATH to opt into native acceptance' : false,
}, async () => {
  assert.ok(executable);
  const root = await mkdtemp(join(tmpdir(), 'ecs-native-chd-'));
  let registry: VirtualProviderRegistry | undefined;
  try {
    const provider = await createChdProvider(executable);
    registry = new VirtualProviderRegistry([provider]);
    const dvd = noisy(2048 * 41);
    await writeFile(join(root, 'dvd-source'), dvd);
    const dvdPath = join(root, 'dvd-chd');
    await native(executable, ['createdvd', '-i', join(root, 'dvd-source'), '-o', dvdPath], {
      maxBuffer: 65536,
    });
    const modes = ['MODE1/2048', 'AUDIO', 'MODE1/2352', 'MODE2/2352'];
    const frames = [79, 83, 87, 91];
    const tracks = modes.map((mode, i) =>
      noisy((mode === 'MODE1/2048' ? 2048 : 2352) * (frames[i] ?? 0), 42 + i),
    );
    let cue = '';
    for (const [i, bytes] of tracks.entries()) {
      await writeFile(join(root, `track-${i}`), bytes);
      cue += `FILE "track-${i}" BINARY\n  TRACK ${String(i + 1).padStart(2, '0')} ${modes[i]}\n    INDEX 01 00:00:00\n`;
    }
    await writeFile(join(root, 'source.cue'), cue);
    const cdPath = join(root, 'cd-chd');
    await native(executable, ['createcd', '-i', join(root, 'source.cue'), '-o', cdPath], {
      maxBuffer: 65536,
    });
    // Add excluded declarations to real generated codec/maps, without real media.
    const mutable = join(root, 'mutable-chd');
    await native(executable, ['copy', '-i', cdPath, '-o', mutable, '-c', 'none'], {
      maxBuffer: 65536,
    });
    const original = await readFile(mutable);
    const track =
      'TRACK:1 TYPE:MODE1 SUBTYPE:NONE FRAMES:79 PREGAP:0 PGTYPE:MODE1 PGSUB:NONE POSTGAP:0';
    const excluded: [string, string, string][] = [
      ['pregap', 'CHT2', track.replace('PREGAP:0', 'PREGAP:2')],
      ['postgap', 'CHT2', track.replace('POSTGAP:0', 'POSTGAP:2')],
      ['subchannels', 'CHT2', track.replace('SUBTYPE:NONE', 'SUBTYPE:RW')],
      ['mode', 'CHT2', track.replace('TYPE:MODE1 ', 'TYPE:MODE2_FORM_MIX ')],
      ['multisession', 'CHSE', 'SESSION:2'],
      ['legacy', 'CHTR', 'unsupported'],
      ['legacy-old', 'CHCD', 'unsupported'],
      ['gdrom', 'CHGD', 'unsupported'],
      ['gdrom-old', 'CHGT', 'unsupported'],
      ['hard-disk', 'GDDD', 'unsupported'],
      ['laserdisc', 'AVLD', 'unsupported'],
      ['av', 'AVAV', 'unsupported'],
      ['conflicting-kind', 'DVD ', ''],
    ];
    for (const [name, tag, value] of excluded) {
      const invalid = join(root, `excluded-${name}`);
      await writeFile(invalid, original);
      await native(executable, ['addmeta', '-i', invalid, '-t', tag, '-ix', '0', '-vt', value], {
        maxBuffer: 65536,
      });
      await assert.rejects(
        registry.inspect(invalid),
        (error: unknown) =>
          error instanceof Error && 'code' in error && error.code === 'unsupported-entry',
        name,
      );
    }
    for (const kind of ['parent', 'old-version'] as const) {
      const bytes = Buffer.from(original);
      if (kind === 'parent') bytes[104] = 1;
      else bytes.writeUInt32BE(4, 12);
      const invalid = join(root, kind);
      await writeFile(invalid, bytes);
      await assert.rejects(registry.inspect(invalid), /Parent-dependent|Only CHD v5/);
    }
    await assert.rejects(
      registry.inspect(cdPath, { offset: 0, length: original.length }),
      /Nested CHD/,
    );
    const expectedBin = Buffer.concat(tracks);
    const expectedCue =
      'FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:01:04\n  TRACK 03 MODE1/2352\n    INDEX 01 00:02:12\n  TRACK 04 MODE2/2352\n    INDEX 01 00:03:24\n';
    for (const [path, outputs] of [
      [dvdPath, [dvd]],
      [cdPath, [Buffer.from(expectedCue), expectedBin]],
    ] as const) {
      const source = await readFile(path);
      await mkdir(dirname(blobPath(root, hash(source))), { recursive: true });
      await writeFile(blobPath(root, hash(source)), source);
      const inspected = await registry.inspect(path);
      assert.deepEqual(
        inspected?.entries.map((entry) => entry.path),
        path === dvdPath ? ['disc.iso'] : ['disc.cue', 'disc.bin'],
      );
      for (const [index, expected] of outputs.entries()) {
        const opened = await openVirtualEntry(root, hash(source), registry, String(index));
        assert.ok(opened);
        const reader = new FileContentReader(opened.path, opened.size);
        const actual = await buffer(reader.openFull());
        assert.equal(hash(actual), hash(expected));
        assert.deepEqual(await buffer(reader.openRange(19, 65)), expected.subarray(19, 66));
        const before = await stat(opened.path);
        const again = await openVirtualEntry(root, hash(source), registry, String(index));
        assert.equal(again?.path, opened.path);
        assert.equal((await stat(opened.path)).mtimeMs, before.mtimeMs);
      }
    }
  } finally {
    await registry?.close();
    await rm(root, { recursive: true, force: true });
  }
});
