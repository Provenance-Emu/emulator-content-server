import assert from 'node:assert/strict';
import { access, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js/index-native.js';
import { discover } from '../src/rom-identification.js';
import { libraryFixture } from './library-fixture.js';

const chdman = await discover(
  undefined,
  process.platform === 'win32' ? ['chdman.exe'] : ['chdman'],
);
const cue = 'FILE "track.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n';

test('owner replaces a verified disc ZIP in place and preserves its source identity', {
  skip: !chdman,
}, async () => {
  const f = await libraryFixture();
  try {
    const path = join(f.base, 'PlayStation');
    await mkdir(path);
    const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
    await zip.add('disc.cue', new Uint8ArrayReader(Buffer.from(cue)));
    await zip.add('track.bin', new Uint8ArrayReader(new Uint8Array(2352 * 300)));
    await writeFile(join(path, 'Demo.zip'), await zip.close());
    const root = f.catalog.createContentRoot({
      path,
      label: 'CDs',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    const scan = () =>
      f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    assert.equal((await scan()).statusCode, 200);
    const source = f.catalog.listSources(root.id)[0];
    assert.ok(source);
    const url = `/api/v1/sources/${source.id}/disc-conversion`;
    const convert = (headers = f.auth) =>
      f.app.inject({ method: 'POST', url, headers, payload: {} });
    const denied = await convert({ authorization: 'Bearer unauthorized' });
    assert.ok([401, 403].includes(denied.statusCode), denied.body);

    await writeFile(join(path, 'Demo.chd'), 'occupied');
    const collision = await convert();
    assert.equal(collision.statusCode, 422, collision.body);
    assert.equal((await readFile(join(path, 'Demo.chd'))).toString(), 'occupied');
    await access(join(path, 'Demo.zip'));
    await unlink(join(path, 'Demo.chd'));

    const converted = await convert();
    assert.equal(converted.statusCode, 200, converted.body);
    assert.deepEqual(converted.json(), {
      sourceId: source.id,
      name: 'Demo.chd',
      keptOriginals: false,
    });
    assert.equal(f.catalog.getSource(source.id)?.relativePath, 'Demo.chd');
    assert.equal((await readFile(join(path, 'Demo.chd'))).subarray(0, 8).toString(), 'MComprHD');
    assert.deepEqual(await readdir(path), ['Demo.chd']);
    assert.equal((await scan()).statusCode, 200);
    assert.equal(f.catalog.listSources(root.id)[0]?.id, source.id);
  } finally {
    await f.dispose();
  }
});

test('folder scan converts only when opted in and can keep all original tracks', {
  skip: !chdman,
}, async () => {
  const f = await libraryFixture();
  try {
    const path = join(f.base, 'PlayStation');
    await mkdir(path);
    await writeFile(join(path, 'Demo.cue'), cue);
    await writeFile(join(path, 'track.bin'), new Uint8Array(2352 * 300));
    const root = f.catalog.createContentRoot({
      path,
      label: 'CDs',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    const scan = () =>
      f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    assert.equal((await scan()).statusCode, 200);
    const source = f.catalog.listSources(root.id).find((file) => file.relativePath === 'Demo.cue');
    assert.ok(source);
    const policy = await f.app.inject({
      method: 'PUT',
      url: `/api/v1/roots/${root.id}/disc-conversion`,
      headers: f.auth,
      payload: { enabled: true, keepOriginals: true },
    });
    assert.equal(policy.statusCode, 200, policy.body);
    const scanned = await scan();
    assert.equal(scanned.statusCode, 200, scanned.body);
    assert.equal(f.catalog.getSource(source.id)?.relativePath, 'Demo.chd');
    assert.equal(f.catalog.listSources(root.id).length, 1);
    const backup = (await readdir(path)).find((name) => name.startsWith('.ecs-chd-'));
    assert.ok(backup);
    assert.equal(await readFile(join(path, backup, 'originals', 'Demo.cue'), 'utf8'), cue);
    assert.equal((await readFile(join(path, backup, 'originals', 'track.bin'))).length, 2352 * 300);
  } finally {
    await f.dispose();
  }
});
