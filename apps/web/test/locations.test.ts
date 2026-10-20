import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentError, type StorageLocationList } from '@ecs/client';
import { get } from 'svelte/store';
import { createStorageLocations, type StorageClient } from '../src/lib/locations.js';
import { selection } from './folder-fixture.js';

const listing = (): StorageLocationList => ({
  items: [
    {
      id: 'disk',
      path: '/server/drive',
      label: 'Drive',
      createdAt: '2026-10-17T00:00:00Z',
      online: false,
    },
  ],
  writeLocationId: 'disk',
});

function fixture() {
  const saved = listing();
  const client: StorageClient = {
    async storageLocations() {
      return structuredClone(saved);
    },
    async addStorageLocation(draft) {
      const location = { ...draft, id: 'new', online: true, createdAt: '2026-10-17T00:00:00Z' };
      saved.items.push(location);
      return location;
    },
    async setStorageWriteTarget(id) {
      saved.writeLocationId = id;
      return { id };
    },
    async removeStorageLocation(id) {
      saved.items = saved.items.filter((location) => location.id !== id);
    },
  };
  return {
    client,
    get saved() {
      return saved;
    },
  };
}

test('an offline selected drive remains visible and Primary can restore new uploads', async () => {
  const f = fixture();
  let changes = 0;
  const locations = createStorageLocations(f.client, () => {
    changes++;
  });
  await locations.load();
  assert.equal(get(locations).listing?.items[0]?.online, false);
  assert.equal(get(locations).listing?.writeLocationId, 'disk');
  await locations.select(null);
  assert.equal(f.saved.writeLocationId, null);
  assert.equal(get(locations).listing?.writeLocationId, null);
  assert.equal(changes, 1);
});

test('add and remove refresh the displayed registrations and notify the audit panel', async () => {
  const f = fixture();
  let changes = 0;
  const locations = createStorageLocations(f.client, () => {
    changes++;
  });
  await locations.load();
  assert.equal(await locations.add({ label: 'USB', path: '/server/usb' }), true);
  assert.equal(get(locations).listing?.items.length, 2);
  await locations.remove('new');
  assert.equal(get(locations).listing?.items.length, 1);
  assert.equal(changes, 2);
});

test('a refused removal keeps the registered location and displays the server problem', async () => {
  const f = fixture();
  f.client.removeStorageLocation = async () => {
    throw new ContentError(409, {
      type: 'urn:ecs:problem:conflict',
      title: 'That location still holds blobs',
      status: 409,
    });
  };
  const locations = createStorageLocations(f.client);
  await locations.load();
  await locations.remove('disk');
  assert.equal(get(locations).listing?.items.length, 1);
  assert.match(get(locations).failure ?? '', /still holds blobs/);
  assert.equal(get(locations).busy, false);
});

test('loss of owner authorization clears displayed paths and prevents further mutations', async () => {
  const f = fixture();
  const locations = createStorageLocations(f.client);
  await locations.load();
  f.client.storageLocations = async () => {
    throw new ContentError(403, null);
  };
  await locations.load();
  assert.equal(get(locations).listing, null);
  assert.equal(get(locations).denied, true);
  assert.equal(await locations.add({ label: 'USB', path: '/server/usb' }), false);
  assert.equal(f.saved.items.length, 1);
});

test('a pending mutation disables controls and blocks duplicate commands and refresh races', async () => {
  const f = fixture();
  let finish: (value: { id: null }) => void = () => {};
  let calls = 0;
  f.client.setStorageWriteTarget = async () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const locations = createStorageLocations(f.client);
  await locations.load();
  const selecting = locations.select(null);
  assert.equal(get(locations).busy, true);
  await locations.select(null);
  await locations.load();
  assert.equal(calls, 1);
  finish({ id: null });
  await selecting;
  assert.equal(get(locations).busy, false);
});

test('a committed add followed by a refresh failure clears the form without allowing a duplicate retry', async () => {
  const f = fixture();
  const locations = createStorageLocations(f.client);
  await locations.load();
  f.client.storageLocations = async () => {
    throw new Error('offline');
  };
  assert.equal(await locations.add({ label: 'USB', path: '/server/usb' }), true);
  assert.equal(f.saved.items.length, 2);
  assert.equal(get(locations).listing, null);
  assert.match(get(locations).failure ?? '', /saved/);
  assert.equal(await locations.add({ label: 'USB', path: '/server/usb' }), false);
  assert.equal(f.saved.items.length, 2);
});

test('a destination defaults to retaining the target and selection retry never registers twice', async () => {
  const f = fixture();
  let adds = 0;
  let selects = 0;
  const add = f.client.addStorageLocation;
  f.client.addStorageLocation = async (draft) => {
    adds++;
    return add(draft);
  };
  const locations = createStorageLocations(f.client, () => {}, {
    key: 'epoch',
    origin: 'http://server.test',
  });
  await locations.load();
  assert.equal(await locations.addDestination(selection('/new'), false), true);
  assert.equal(f.saved.writeLocationId, 'disk');
  f.client.setStorageWriteTarget = async (id) => {
    selects++;
    if (selects === 1) throw new Error('selection failed');
    f.saved.writeLocationId = id;
    return { id };
  };
  assert.equal(await locations.addDestination(selection('/another'), true), false);
  assert.equal(get(locations).pendingDestination?.id, 'new');
  assert.equal(await locations.addDestination(selection('/another'), true), true);
  assert.equal(adds, 2);
  assert.equal(selects, 2);
  assert.equal(f.saved.writeLocationId, 'new');
});

test('disposed storage cannot apply pending reads or register a stale native selection', async () => {
  const f = fixture();
  const context = { key: 'epoch', origin: 'http://server.test' };
  const locations = createStorageLocations(f.client, () => {}, context);
  await locations.load();
  context.key = 'other';
  assert.equal(await locations.addDestination(selection(), false), false);
  locations.dispose();
  await locations.load();
  assert.equal(get(locations).listing, null);
});

test('a saved destination can finish target selection from its row after dismissing the chooser', async () => {
  const f = fixture();
  const locations = createStorageLocations(f.client, () => {}, {
    key: 'epoch',
    origin: 'http://server.test',
  });
  await locations.load();
  f.client.setStorageWriteTarget = async () => {
    throw new Error('offline');
  };
  assert.equal(await locations.addDestination(selection('/saved'), true), false);
  assert.equal(get(locations).pendingDestination?.id, 'new');
  f.client.setStorageWriteTarget = async (id) => {
    f.saved.writeLocationId = id;
    return { id };
  };
  await locations.select('new');
  assert.equal(get(locations).pendingDestination, null);
  assert.equal(await locations.addDestination(selection('/different'), false), true);
  assert.equal(f.saved.items.length, 3);
});
