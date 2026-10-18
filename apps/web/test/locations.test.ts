import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentError, type StorageLocationList } from '@ecs/client';
import { get } from 'svelte/store';
import { createStorageLocations, type StorageClient } from '../src/lib/locations.js';

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
