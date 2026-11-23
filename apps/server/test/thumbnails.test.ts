import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { animated, createThumbnails, pictureSize } from '../src/thumbnails.js';
import { libraryFixture } from './library-fixture.js';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
/** A generated picture. `alpha` leaves its left half see-through. */
function png(width: number, height: number, alpha = false, body?: Buffer): Buffer {
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * channels + 1) + 1 + x * channels;
      raw[at] = (x >> 2) & 255;
      raw[at + 1] = (y >> 2) & 255;
      raw[at + 2] = 96;
      if (alpha) raw[at + 3] = x < width / 2 ? 0 : 255;
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, alpha ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', body ?? deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function fixture() {
  const f = await libraryFixture({ localTrust: false });
  const path = join(f.base, 'games');
  await mkdir(path);
  for (const name of ['One.nes', 'Two.nes', 'Three.nes', 'Four.nes'])
    await writeFile(join(path, name), Buffer.from(name));
  const root = f.catalog.createContentRoot({
    path,
    label: 'Generated',
    libraryId: f.library.id,
    actorId: f.owner.id,
  });
  await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
  const sources = f.catalog.listSources(root.id);
  const id = (name: string) => {
    const source = sources.find((candidate) => candidate.displayName === name);
    assert.ok(source);
    return source.id;
  };
  async function save(source: string, picture: Buffer) {
    const base = `/api/v1/sources/${source}/matches/selections`;
    const state = await f.app.inject({ url: base, headers: f.auth });
    const response = await f.app.inject({
      method: 'PUT',
      url: `/api/v1/sources/${source}/details/cover`,
      headers: {
        ...f.auth,
        'content-type': 'image/png',
        'if-match': `"rev-${state.json().revision}"`,
      },
      payload: picture,
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  const cover = (source: string, query = '', headers: Record<string, string> = f.auth) =>
    f.app.inject({
      url: `/api/v1/sources/${source}/matches/selections/artwork/content${query}`,
      headers,
    });
  return { f, id, save, cover };
}

test('a grid is given a smaller copy of a large cover, and the saved file is untouched', async () => {
  const { f, id, save, cover } = await fixture();
  try {
    const original = png(1200, 1600);
    const digest = createHash('sha256').update(original).digest('hex');
    await save(id('One.nes'), original);

    const small = await cover(id('One.nes'), `?width=480&v=${digest}`);
    assert.equal(small.statusCode, 200, small.body);
    assert.equal(small.headers['content-type'], 'image/jpeg');
    assert.deepEqual(pictureSize(small.rawPayload), { width: 480, height: 640 });
    assert.ok(small.rawPayload.length < original.length);
    assert.match(String(small.headers['cache-control']), /immutable/);
    assert.match(String(small.headers.vary), /authorization/i);

    // The saved file is still what a request without a width receives.
    const full = await cover(id('One.nes'), `?v=${digest}`);
    assert.deepEqual(full.rawPayload, original);
    assert.notEqual(full.headers.etag, small.headers.etag);

    // The copy is drawn once: the second answer is the same bytes, from the data folder.
    const again = await cover(id('One.nes'), '?width=480');
    assert.deepEqual(again.rawPayload, small.rawPayload);
    assert.doesNotMatch(String(again.headers['cache-control']), /immutable/);
    assert.deepEqual(await readdir(join(f.base, 'data', 'cache', 'thumbnails')), [
      `${digest}-480.jpg`,
    ]);
    const unchanged = await cover(id('One.nes'), '?width=480', {
      ...f.auth,
      'if-none-match': String(small.headers.etag),
    });
    assert.equal(unchanged.statusCode, 304);
  } finally {
    await f.dispose();
  }
});

test('a see-through cover keeps its transparency, and a small one is sent as saved', async () => {
  const { f, id, save, cover } = await fixture();
  try {
    await save(id('One.nes'), png(800, 600, true));
    const cutout = await cover(id('One.nes'), '?width=240');
    assert.equal(cutout.headers['content-type'], 'image/webp');
    assert.deepEqual(pictureSize(cutout.rawPayload), { width: 240, height: 180 });

    const tiny = png(200, 280);
    await save(id('Two.nes'), tiny);
    const same = await cover(id('Two.nes'), '?width=480');
    assert.equal(same.headers['content-type'], 'image/png');
    assert.deepEqual(same.rawPayload, tiny);
  } finally {
    await f.dispose();
  }
});

test('a cover that cannot be redrawn is sent as saved and does not stop the others', async () => {
  const { f, id, save, cover } = await fixture();
  try {
    // A valid header over a body that is not image data.
    const damaged = png(900, 900, false, Buffer.from('not compressed image data'));
    await save(id('One.nes'), damaged);
    // Larger than the server will decode: 20,000 by 20,000 pixels in the header.
    const huge = png(20_000, 20_000, false, deflateSync(Buffer.alloc(16)));
    await save(id('Two.nes'), huge);
    const good = png(1000, 1000);
    await save(id('Three.nes'), good);

    const first = await cover(id('One.nes'), '?width=480');
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.rawPayload, damaged);
    assert.deepEqual((await cover(id('Two.nes'), '?width=480')).rawPayload, huge);
    const after = await cover(id('Three.nes'), '?width=480');
    assert.equal(after.headers['content-type'], 'image/jpeg');
    assert.deepEqual(pictureSize(after.rawPayload), { width: 480, height: 480 });
    // Asked again, the damaged one is still answered, as saved.
    assert.deepEqual((await cover(id('One.nes'), '?width=480')).rawPayload, damaged);
  } finally {
    await f.dispose();
  }
});

test('a smaller copy is only for someone who may see the game, at a width the server offers', async () => {
  const { f, id, save, cover } = await fixture();
  try {
    await save(id('One.nes'), png(1000, 1000));
    assert.equal((await cover(id('One.nes'), '?width=481')).statusCode, 400);
    assert.equal((await cover(id('One.nes'), '?width=abc')).statusCode, 400);
    assert.equal((await cover(id('One.nes'), '?width=480', {})).statusCode, 401);
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: f.auth,
      payload: { username: 'outsider', password: 'generated-password' },
    });
    const login = await f.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'outsider', password: 'generated-password' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const outsider = { authorization: `Bearer ${login.json().token}` };
    // Drawn for the owner first, so a copy exists in the data folder.
    assert.equal((await cover(id('One.nes'), '?width=480')).statusCode, 200);
    assert.notEqual((await cover(id('One.nes'), '?width=480', outsider)).statusCode, 200);
  } finally {
    await f.dispose();
  }
});

test('picture sizes are read from PNG, JPEG and WebP headers', () => {
  assert.deepEqual(pictureSize(png(31, 17)), { width: 31, height: 17 });
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc4, 0, 3, 0, 0xff, 0xc2, 0, 11, 8, 0x01, 0x2c, 0x02,
    0x58, 3, 0, 0, 0, 0, 0,
  ]);
  assert.deepEqual(pictureSize(jpeg), { width: 600, height: 300 });
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBPVP8X', 8, 'ascii');
  webp.writeUIntLE(799, 24, 3);
  webp.writeUIntLE(599, 27, 3);
  assert.deepEqual(pictureSize(webp), { width: 800, height: 600 });
  assert.equal(pictureSize(Buffer.from('plain text, not a picture at all')), null);
});

test('a copy that could not be made this time is not kept as the answer', async () => {
  const { f, id, save, cover } = await fixture();
  try {
    // Sixty covers asked for at once is more than the server draws at a time.
    const names = Array.from({ length: 60 }, (_, index) => `Burst ${index}.nes`);
    const path = join(f.base, 'burst');
    await mkdir(path);
    for (const name of names) await writeFile(join(path, name), Buffer.from(name));
    const root = f.catalog.createContentRoot({
      path,
      label: 'Burst',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const sources = f.catalog.listSources(root.id);
    const pictures = new Map<string, string>();
    for (const [index, source] of sources.entries()) {
      const picture = png(600 + index, 600);
      await save(source.id, picture);
      pictures.set(source.id, createHash('sha256').update(picture).digest('hex'));
    }
    void id;
    const answers = await Promise.all(
      [...pictures].map(([source, digest]) => cover(source, `?width=480&v=${digest}`)),
    );
    const small = answers.filter((answer) => answer.headers['content-type'] === 'image/jpeg');
    const whole = answers.filter((answer) => answer.headers['content-type'] === 'image/png');
    assert.equal(small.length + whole.length, 60);
    assert.ok(small.length > 0 && whole.length > 0, `${small.length} small, ${whole.length} whole`);
    for (const answer of small) assert.match(String(answer.headers['cache-control']), /immutable/);
    for (const answer of whole)
      assert.doesNotMatch(String(answer.headers['cache-control']), /immutable|max-age/);
    // Asked again one at a time, every one of them is drawn.
    for (const [source, digest] of pictures)
      assert.equal(
        (await cover(source, `?width=480&v=${digest}`)).headers['content-type'],
        'image/jpeg',
      );
  } finally {
    await f.dispose();
  }
});

test('a copy is never kept under the digest of a different file', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ecs-thumbnails-'));
  const thumbnails = createThumbnails(base);
  try {
    const first = png(900, 900);
    const second = png(901, 900);
    const digest = createHash('sha256').update(first).digest('hex');
    // The cover was replaced between reading its digest and reading its bytes.
    assert.equal(await thumbnails.get(digest, 480, () => second), null);
    assert.deepEqual(await readdir(join(base, 'cache', 'thumbnails')).catch(() => []), []);
    const made = await thumbnails.get(digest, 480, () => first);
    assert.ok(made && made !== 'as-saved');
    assert.deepEqual(pictureSize(made.bytes), { width: 480, height: 480 });
  } finally {
    await thumbnails.close();
    await rm(base, { recursive: true, force: true });
  }
});

test('an animated picture is left as it was saved', async () => {
  const still = png(900, 900);
  const moving = Buffer.concat([
    still.subarray(0, 33),
    chunk('acTL', Buffer.alloc(8)),
    still.subarray(33),
  ]);
  assert.equal(animated(still), false);
  assert.equal(animated(moving), true);
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBPVP8X', 8, 'ascii');
  assert.equal(animated(webp), false);
  webp[20] = 2;
  assert.equal(animated(webp), true);
  const base = await mkdtemp(join(tmpdir(), 'ecs-thumbnails-'));
  const thumbnails = createThumbnails(base);
  try {
    const digest = createHash('sha256').update(moving).digest('hex');
    assert.equal(await thumbnails.get(digest, 480, () => moving), 'as-saved');
  } finally {
    await thumbnails.close();
    await rm(base, { recursive: true, force: true });
  }
});
