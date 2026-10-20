import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { libraryFixture } from './library-fixture.js';

test('owner rename requires revision and assignment preserves identities with audit', async () => {
  const f = await libraryFixture();
  try {
    const url = `/api/v1/libraries/${f.library.id}`;
    assert.equal(
      (await f.app.inject({ method: 'PATCH', url, headers: f.auth, payload: { name: 'New' } }))
        .statusCode,
      428,
    );
    const renamed = await f.app.inject({
      method: 'PATCH',
      url,
      headers: { ...f.auth, 'if-match': '"rev-1"' },
      payload: { name: 'New' },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(renamed.json().name, 'New');
    assert.equal(renamed.json().revision, 2);
    assert.equal(
      (
        await f.app.inject({
          method: 'PATCH',
          url,
          headers: { ...f.auth, 'if-match': '"rev-1"' },
          payload: { name: 'Again' },
        })
      ).statusCode,
      409,
    );
    const path = join(f.base, 'library-folder');
    await mkdir(path);
    await writeFile(join(path, 'file.nes'), 'generated');
    const root = f.catalog.createContentRoot({
      path,
      label: 'Legacy',
      libraryId: null,
      actorId: f.owner.id,
    });
    const initial = await f.app.inject({
      url: '/api/v1/root-summaries?unassigned=true',
      headers: f.auth,
    });
    assert.equal(initial.statusCode, 200, initial.body);
    assert.equal(initial.json().items[0].online, null);
    assert.equal(initial.json().items[0].scanState, 'unknown');
    const scanned = await f.app.inject({
      method: 'POST',
      url: `/api/v1/roots/${root.id}/scan`,
      headers: f.auth,
    });
    assert.equal(scanned.statusCode, 200, scanned.body);
    const summary = (
      await f.app.inject({ url: '/api/v1/root-summaries?unassigned=true', headers: f.auth })
    ).json().items[0];
    assert.equal(summary.scanState, 'completed');
    assert.equal(summary.indexedFileCount, 1);
    assert.ok(summary.lastScanAt);
    assert.ok(summary.lastCheckAt);
    const ids = f.catalog.listSources(root.id).map((s) => s.id);
    const assigned = await f.app.inject({
      method: 'PUT',
      url: `/api/v1/roots/${root.id}/library`,
      headers: f.auth,
      payload: { libraryId: f.library.id },
    });
    assert.equal(assigned.statusCode, 200, assigned.body);
    assert.equal(assigned.json().libraryId, f.library.id);
    assert.deepEqual(
      f.catalog.listSources(root.id).map((s) => s.id),
      ids,
    );
    const audit = (await f.app.inject({ url: '/api/v1/audit', headers: f.auth }))
      .json()
      .events.map((e: { action: string }) => e.action);
    assert.ok(audit.includes('rename-library'));
    assert.ok(audit.includes('assign-content-root'));
  } finally {
    await f.dispose();
  }
});

test('explicit scan persists pending/completed/failed state and sanitizes failures', async () => {
  const f = await libraryFixture();
  try {
    const path = join(f.base, 'scan-state');
    await mkdir(path);
    await writeFile(join(path, 'file.nes'), 'generated');
    const root = f.catalog.createContentRoot({
      path,
      label: 'State',
      libraryId: f.library.id,
      actorId: f.owner.id,
    });
    const original = f.catalog.applyInspection.bind(f.catalog);
    let pending = false;
    f.catalog.applyInspection = () => {
      pending = f.catalog.listContentRootSummaries({ actor: f.actor })[0]?.scanState === 'pending';
      throw new Error(`private failure ${path}`);
    };
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/v1/roots/${root.id}/scan`,
      headers: f.auth,
    });
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.includes(path), false);
    assert.equal(pending, true);
    const failed = f.catalog.listContentRootSummaries({ actor: f.actor })[0];
    assert.equal(failed?.scanState, 'failed');
    assert.equal(failed?.scanError, 'Scan failed. Retry scan.');
    assert.ok(failed?.lastScanCompletedAt);
    f.catalog.applyInspection = original;
    const retry = await f.app.inject({
      method: 'POST',
      url: `/api/v1/roots/${root.id}/scan`,
      headers: f.auth,
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(f.catalog.listContentRoots().length, 1);
    assert.equal(f.catalog.listContentRootSummaries({ actor: f.actor })[0]?.scanState, 'completed');
    f.catalog.beginRootScan(root.id);
    const duplicate = await f.app.inject({
      method: 'POST',
      url: `/api/v1/roots/${root.id}/scan`,
      headers: f.auth,
    });
    assert.equal(duplicate.statusCode, 409);
  } finally {
    await f.dispose();
  }
});

test('legacy library creation remains available to admin-scoped users while new management needs owner authority', async () => {
  const f = await libraryFixture();
  try {
    const { issueToken } = await import('@ecs/auth');
    const user = f.catalog.createUser({
      username: 'creator',
      passwordHash: 'fixture',
      actorId: f.owner.id,
    });
    const token = issueToken();
    f.catalog.createSession(user.id, token.hash);
    const headers = { authorization: `Bearer ${token.token}` };
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/v1/libraries',
      headers,
      payload: { name: 'Created' },
    });
    assert.equal(created.statusCode, 201, created.body);
    for (const request of [
      { url: '/api/v1/root-summaries' },
      {
        method: 'PATCH' as const,
        url: `/api/v1/libraries/${created.json().id}`,
        headers: { ...headers, 'if-match': '"rev-1"' },
        payload: { name: 'Denied' },
      },
      {
        method: 'PUT' as const,
        url: '/api/v1/roots/missing/library',
        payload: { libraryId: created.json().id },
      },
    ])
      assert.equal(
        (
          await f.app.inject({
            ...request,
            headers: 'headers' in request ? request.headers : headers,
          })
        ).statusCode,
        403,
      );
  } finally {
    await f.dispose();
  }
});
