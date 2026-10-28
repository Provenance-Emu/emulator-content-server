import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { libraryFixture } from './library-fixture.js';

test('artwork roles save independently, old clients see front only, and PDF manuals download as attachments', async () => {
  const f = await libraryFixture();
  try {
    const path = join(f.base, 'roles');
    await mkdir(path);
    await writeFile(join(path, 'Game.nes'), Buffer.from([1, 2, 3, 4]));
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    for (const role of ['front', 'back', 'disc'])
      await writeFile(join(path, `Game ${role}.png`), image);
    const pdf = Buffer.from('%PDF-1.4\nGenerated manual fixture\n%%EOF');
    await writeFile(join(path, 'Game manual.pdf'), pdf);
    const root = f.catalog.createContentRoot({
      path,
      label: 'Roles',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    await f.app.inject({ method: 'POST', url: `/api/v1/roots/${root.id}/scan`, headers: f.auth });
    const source = f.catalog.listSources(root.id).find((s) => s.displayName === 'Game.nes');
    assert.ok(source);
    const url = `/api/v1/sources/${source.id}/matches`;
    const response = await f.app.inject({
      method: 'POST',
      url,
      headers: f.auth,
      payload: { online: false },
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    for (const [revision, role] of ['front', 'back', 'disc', 'manual'].entries()) {
      const candidate = result.candidates.find(
        (c: { metadata: Record<string, string> }) => c.metadata.artworkRole === role,
      );
      assert.ok(candidate, role);
      const saved = await f.app.inject({
        method: 'PUT',
        url: `${url}/selections?includeArtworkRoles=true`,
        headers: f.auth,
        payload: {
          requestId: result.requestId,
          candidateId: candidate.id,
          expectedRevision: revision,
        },
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json().matches.length, revision + 1);
    }
    const legacy = await f.app.inject({ url: `${url}/selections`, headers: f.auth });
    assert.equal(legacy.json().matches.length, 1);
    assert.equal(legacy.json().matches[0].artworkRole, 'front');
    const manual = await f.app.inject({
      url: `${url}/selections/artwork/content?artworkRole=manual`,
      headers: f.auth,
    });
    assert.equal(manual.statusCode, 200, manual.body);
    assert.equal(manual.headers['content-type'], 'application/pdf');
    assert.match(String(manual.headers['content-disposition']), /^attachment/);
    assert.deepEqual(manual.rawPayload, pdf);
    const removed = await f.app.inject({
      method: 'DELETE',
      url: `${url}/selections/artwork?artworkRole=back&includeArtworkRoles=true`,
      headers: { ...f.auth, 'if-match': '"rev-4"' },
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.deepEqual(
      removed
        .json()
        .matches.map((m: { artworkRole: string }) => m.artworkRole)
        .sort(),
      ['disc', 'front', 'manual'],
    );
    const front = await f.app.inject({ url: `${url}/selections/artwork/content`, headers: f.auth });
    assert.deepEqual(front.rawPayload, image);
    const bad = await f.app.inject({
      url: `${url}/selections/artwork/content?artworkRole=wrong`,
      headers: f.auth,
    });
    assert.equal(bad.statusCode, 400);
  } finally {
    await f.dispose();
  }
});
