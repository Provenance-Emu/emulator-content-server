import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ContentClient } from '@ecs/client';
import { chooseFolder } from '../../web/src/lib/folder-selection.js';
import { createLibraryEditor } from '../../web/src/lib/library-editor.js';
import { createLibraryFolders } from '../../web/src/lib/library-folders.js';
import { createStorageLocations } from '../../web/src/lib/locations.js';
import type { DesktopContext } from '../src/lib/application.js';
import {
  createManagedFolderAdapter,
  type ManagedEndpoint,
  managedProfile,
  type NativeFolders,
} from '../src/lib/folders.js';

function withFetch(t: TestContext, fetch: typeof globalThis.fetch) {
  const old = globalThis.fetch;
  globalThis.fetch = fetch;
  t.after(() => {
    globalThis.fetch = old;
  });
  return new ContentClient('http://127.0.0.1:7878');
}

const endpoint: Extract<ManagedEndpoint, { available: true }> = {
  available: true,
  origin: 'http://127.0.0.1:7878',
  verificationId: 'opaque-native-id',
};
function setup(profileKey = 'managed-service') {
  let current = {
    key: 'context',
    origin: endpoint.origin,
    profile: { origin: endpoint.origin, label: 'Local service', profileKey },
  } as DesktopContext;
  let valid = true;
  let chosen: string | null = '/Volumes/Arcade';
  let pending: (() => Promise<string | null>) | undefined;
  const native: NativeFolders = {
    async managedEndpoint() {
      return endpoint;
    },
    async chooseDirectory() {
      return pending ? pending() : chosen;
    },
    async validate() {
      return valid;
    },
  };
  const adapter = () => createManagedFolderAdapter(current, endpoint, native, () => current);
  return {
    native,
    adapter,
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
    set valid(value: boolean) {
      valid = value;
    },
    set chosen(value: string | null) {
      chosen = value;
    },
    set pending(value: () => Promise<string | null>) {
      pending = value;
    },
  };
}
function shared(s: ReturnType<typeof setup>) {
  return { key: s.current.key, origin: s.current.origin, folderSelection: s.adapter() };
}

test('only an explicit native-derived managed profile receives the adapter', () => {
  assert.deepEqual(managedProfile(endpoint), {
    origin: 'http://127.0.0.1:7878',
    label: 'Local managed service',
    profileKey: 'managed-service',
  });
  for (const profile of ['manual', 'discovered', 'remote'])
    assert.equal(setup(profile).adapter(), undefined);
  const s = setup();
  s.current = { ...s.current, origin: 'https://remote.example' };
  assert.equal(s.adapter(), undefined);
  assert.equal(
    createManagedFolderAdapter(
      s.current,
      { available: false, reason: 'unverifiable' },
      s.native,
      () => s.current,
    ),
    undefined,
  );
});

test('native cancellation makes no registration and never becomes a server selection', async (t) => {
  const s = setup();
  s.chosen = null;
  const context = shared(s);
  let writes = 0;
  const client = withFetch(t, async () => {
    writes++;
    throw new Error('Unexpected API write');
  });
  const folders = createLibraryFolders(client, context, { libraryId: 'library' });
  const selected = await chooseFolder(context, 'library-folder');
  if (selected) await folders.add(selected);
  assert.equal(selected, null);
  assert.equal(writes, 0);
});

test('native confirmation uses shared registration with inferred name and one scan', async (t) => {
  const s = setup();
  const context = shared(s);
  const requests: { path: string; body: unknown }[] = [];
  const client = withFetch(t, async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'POST')
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path.endsWith('/root-summaries')) return Response.json({ items: [] });
    return Response.json(
      path === '/api/v1/roots'
        ? { id: 'root', path: '/Volumes/Arcade', label: 'Arcade', libraryId: 'library' }
        : { id: 'scan', state: 'queued' },
    );
  });
  const selected = await chooseFolder(context, 'library-folder');
  assert.ok(selected);
  assert.equal(
    await createLibraryFolders(client, context, { libraryId: 'library' }).add(selected),
    true,
  );
  assert.deepEqual(
    requests.map((r) => r.path),
    ['/api/v1/roots', '/api/v1/roots/root/scan'],
  );
  assert.deepEqual(requests[0]?.body, {
    path: '/Volumes/Arcade',
    label: 'Arcade',
    libraryId: 'library',
  });
});

test('restart just before shared registration prevents the write', async (t) => {
  const s = setup();
  const context = shared(s);
  const selected = await chooseFolder(context, 'library-folder');
  assert.ok(selected);
  s.valid = false;
  let writes = 0;
  const client = withFetch(t, async () => {
    writes++;
    throw new Error('Unexpected write');
  });
  assert.equal(
    await createLibraryFolders(client, context, { libraryId: 'library' }).add(selected),
    false,
  );
  assert.equal(writes, 0);
});

test('changing context while the native dialog is open discards its result', async () => {
  const s = setup();
  const context = shared(s);
  s.pending = async () => {
    s.current = { ...s.current, key: 'replacement' };
    return '/Volumes/Arcade';
  };
  assert.equal(await chooseFolder(context, 'library-folder'), null);
});

test('failed validation before dialog gives a recovery action without opening it and IPC failures are sanitized', async () => {
  const s = setup();
  s.valid = false;
  s.pending = async () => {
    throw new Error('The dialog must not open');
  };
  const adapter = s.adapter();
  assert.ok(adapter);
  await assert.rejects(
    () => adapter.choose({ contextKey: 'context', purpose: 'library-folder' }),
    /Use local managed service|Connect/,
  );
  s.valid = true;
  s.pending = async () => {
    throw new Error('raw sensitive native error');
  };
  await assert.rejects(
    () => adapter.choose({ contextKey: 'context', purpose: 'library-folder' }),
    (error) => error instanceof Error && !error.message.includes('sensitive'),
  );
});

test('native folders for new libraries are staged without writes', async (t) => {
  const s = setup();
  const context = shared(s);
  let writes = 0;
  const client = withFetch(t, async () => {
    writes++;
    throw new Error('Unexpected write');
  });
  const selected = await chooseFolder(context, 'library-folder');
  assert.ok(selected);
  assert.equal(await createLibraryEditor(client, context).stageFolder(selected), true);
  assert.equal(writes, 0);
});

test('upload destination registration preserves the current write target', async (t) => {
  const s = setup();
  const context = shared(s);
  const writes: string[] = [];
  const client = withFetch(t, async (url, init) => {
    if (init?.method === 'POST') writes.push(new URL(String(url)).pathname);
    return Response.json(
      init?.method === 'POST'
        ? { id: 'destination', label: 'Arcade', path: '/Volumes/Arcade', online: true }
        : { items: [], writeLocationId: null },
    );
  });
  const selected = await chooseFolder(context, 'upload-storage');
  assert.ok(selected);
  const locations = createStorageLocations(client, () => {}, context);
  await locations.load();
  assert.equal(await locations.addDestination(selected, false), true);
  assert.deepEqual(writes, ['/api/v1/storage-locations']);
});
