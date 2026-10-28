import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentError } from '@ecs/client';
import { get } from 'svelte/store';
import {
  createEmulatorSettings,
  type EmulatorManagementClient,
} from '../src/lib/emulator-settings.js';
import { playerManagementFixture, playerProfile } from './player-management-fixture.js';

function fixture() {
  const saved = playerManagementFixture();
  const calls: string[] = [];
  const client: EmulatorManagementClient = {
    async playerManagement() {
      calls.push('read');
      return structuredClone(saved);
    },
    async installPlayer(id) {
      calls.push(`install:${id}`);
      saved.items.push({
        profile: playerProfile(id),
        enabled: true,
        source: 'managed',
        removable: true,
      });
      return structuredClone(saved);
    },
    async installPlayerPackage(file) {
      calls.push(`package:${file.size}`);
      saved.items.push({
        profile: playerProfile('package'),
        enabled: true,
        source: 'managed',
        removable: true,
      });
      return structuredClone(saved);
    },
    async installPlayerSystemFile(id, name, file) {
      calls.push(`system:${id}:${name}:${file.size}`);
      const item = saved.items.find((item) => item.profile.id === id);
      if (!item) throw new Error('Missing generated installation');
      item.profile.assets = [
        ...item.profile.assets.filter((asset) => asset.name !== name),
        {
          name,
          sizeBytes: file.size,
          sha256: '0'.repeat(64),
          url: `/play/plugins/${id}/assets/${name}`,
        },
      ];
      return structuredClone(saved);
    },
    async configurePlayer(id, patch) {
      calls.push(`configure:${id}`);
      const item = saved.items.find((item) => item.profile.id === id);
      if (!item) throw new Error('Missing generated installation');
      if (patch.enabled !== undefined) item.enabled = patch.enabled;
      if (patch.default) saved.defaultProfileId = id;
      return structuredClone(saved);
    },
    async removePlayer(id) {
      calls.push(`remove:${id}`);
      saved.items = saved.items.filter((item) => item.profile.id !== id);
      if (saved.defaultProfileId === id) saved.defaultProfileId = null;
      return structuredClone(saved);
    },
  };
  return { client, calls, saved };
}

test('browsing is read-only, unavailable cores and operator installs never issue writes', async () => {
  const f = fixture();
  let changes = 0;
  const settings = createEmulatorSettings(f.client, () => {
    changes++;
  });
  assert.deepEqual(f.calls, []);
  assert.equal(await settings.load(), true);
  assert.equal(await settings.install('unsupported'), false);
  assert.equal(await settings.configure('operator', { enabled: false }), false);
  assert.equal(await settings.configure('operator', { default: true }), false);
  assert.equal(await settings.remove('operator'), false);
  assert.equal(await settings.configure('disabled', { default: true }), false);
  assert.deepEqual(f.calls, ['read']);
  assert.equal(changes, 0);
});

test('successful management uses returned state and refreshes the playback catalog once per change', async () => {
  const f = fixture();
  let changes = 0;
  const settings = createEmulatorSettings(f.client, () => {
    changes++;
  });
  await settings.load();
  assert.equal(await settings.install('supported'), true);
  assert.equal(await settings.install('supported'), false);
  assert.equal(await settings.configure('disabled', { enabled: true }), true);
  assert.equal(await settings.configure('disabled', { default: true }), true);
  assert.equal(get(settings).listing?.defaultProfileId, 'disabled');
  assert.equal(await settings.remove('disabled'), true);
  assert.equal(get(settings).listing?.defaultProfileId, null);
  assert.equal(changes, 4);
  assert.deepEqual(f.calls, [
    'read',
    'install:supported',
    'configure:disabled',
    'configure:disabled',
    'remove:disabled',
  ]);
});

test('a package requires an explicit valid selection, and only its bytes reach the upload method', async () => {
  const f = fixture();
  const settings = createEmulatorSettings(f.client);
  await settings.load();
  const file = new Blob([new Uint8Array([1, 2, 3, 4])]);
  assert.equal(await settings.installPackage(file, 'player.zip'), false);
  assert.match(get(settings).failure ?? '', /\.ecsplayer/);
  assert.equal(await settings.installPackage(new Blob(), 'empty.ecsplayer'), false);
  assert.deepEqual(f.calls, ['read']);
  assert.equal(await settings.installPackage(file, 'console.ECSPLAYER'), true);
  assert.deepEqual(f.calls, ['read', 'package:4']);
});

test('an in-flight action blocks overlapping commands and refreshes', async () => {
  const f = fixture();
  let finish = (_: typeof f.saved) => {};
  f.client.installPlayer = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const settings = createEmulatorSettings(f.client);
  await settings.load();
  const pending = settings.install('supported');
  assert.equal(get(settings).busy, true);
  assert.equal(await settings.load(), false);
  assert.equal(await settings.install('supported'), false);
  assert.equal(await settings.configure('managed', { enabled: false }), false);
  assert.equal(await settings.remove('managed'), false);
  finish(structuredClone(f.saved));
  await pending;
  assert.equal(get(settings).busy, false);
});

test('a lost install response requires reconciliation before another write and never duplicates a committed install', async () => {
  const f = fixture();
  let changes = 0;
  const install = f.client.installPlayer;
  f.client.installPlayer = async (id) => {
    await install(id);
    throw new TypeError('connection lost');
  };
  const settings = createEmulatorSettings(f.client, () => {
    changes++;
  });
  await settings.load();
  assert.equal(await settings.install('supported'), false);
  assert.equal(get(settings).needsRefresh, true);
  assert.equal(await settings.install('supported'), false);
  assert.equal(await settings.configure('managed', { enabled: false }), false);
  assert.equal(await settings.load(), true);
  assert.equal(get(settings).needsRefresh, false);
  assert.equal(await settings.install('supported'), false);
  assert.equal(changes, 1);
  assert.deepEqual(f.calls, ['read', 'install:supported', 'read']);
});

test('a saved change whose catalog refresh fails retries only reads and the refresh callback', async () => {
  const f = fixture();
  let changes = 0;
  const settings = createEmulatorSettings(f.client, () => {
    changes++;
    if (changes === 1) throw new Error('catalog offline');
  });
  await settings.load();
  assert.equal(await settings.configure('managed', { enabled: false }), true);
  assert.equal(get(settings).listing?.items[0]?.enabled, false);
  assert.match(get(settings).failure ?? '', /saved/i);
  assert.equal(get(settings).needsRefresh, true);
  assert.equal(await settings.load(), true);
  assert.equal(changes, 2);
  assert.deepEqual(f.calls, ['read', 'configure:managed', 'read']);
});

for (const status of [401, 403, 404] as const) {
  test(`${status} clears management details without fabricating an empty catalog`, async () => {
    const f = fixture();
    const rejections: number[] = [];
    const settings = createEmulatorSettings(
      f.client,
      () => {},
      (status) => {
        rejections.push(status);
      },
    );
    await settings.load();
    f.client.playerManagement = async () => {
      throw new ContentError(status, null);
    };
    assert.equal(await settings.load(), false);
    assert.equal(get(settings).listing, null);
    assert.deepEqual(rejections, status === 404 ? [] : [status]);
    assert.equal(await settings.install('supported'), false);
    if (status === 403) assert.match(get(settings).failure ?? '', /sign in.*owner/i);
    if (status === 404) assert.match(get(settings).failure ?? '', /not available/i);
  });
}

test('disposal suppresses delayed results and playback-catalog callbacks', async () => {
  const f = fixture();
  let finish = (_: typeof f.saved) => {};
  f.client.installPlayer = async () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  let changes = 0;
  const settings = createEmulatorSettings(f.client, () => {
    changes++;
  });
  await settings.load();
  const pending = settings.install('supported');
  settings.dispose();
  finish(structuredClone(f.saved));
  assert.equal(await pending, false);
  assert.equal(get(settings).listing, null);
  assert.equal(changes, 0);
});

test('a failed reconciliation never claims an uncertain install was saved', async () => {
  const f = fixture();
  const settings = createEmulatorSettings(f.client);
  await settings.load();
  f.client.installPlayer = async () => {
    throw new TypeError('connection lost');
  };
  await settings.install('supported');
  f.client.playerManagement = async () => {
    throw new TypeError('still offline');
  };
  assert.equal(await settings.load(), false);
  assert.equal(get(settings).needsRefresh, true);
  assert.equal(get(settings).message, null);
  assert.doesNotMatch(get(settings).failure ?? '', /change saved/i);
});

test('a concurrently removed emulator explains the missing entry and refreshes playback choices', async () => {
  const f = fixture();
  let changes = 0;
  const settings = createEmulatorSettings(f.client, () => {
    changes++;
  });
  await settings.load();
  f.client.removePlayer = async () => {
    f.saved.items = f.saved.items.filter((item) => item.profile.id !== 'managed');
    throw new ContentError(404, {
      type: 'urn:ecs:not-found',
      title: 'Emulator is not installed',
      status: 404,
    });
  };
  assert.equal(await settings.remove('managed'), false);
  assert.equal(get(settings).listing, null);
  assert.match(get(settings).failure ?? '', /Emulator is not installed/);
  assert.doesNotMatch(get(settings).failure ?? '', /server version/);
  assert.equal(changes, 0);
  await settings.load();
  assert.equal(changes, 1);
});

test('Atomiswave system files upload only to a managed compatible core with a bounded known filename', async () => {
  const f = fixture();
  const profile = f.saved.items[0]?.profile;
  if (!profile) throw new Error('Missing fixture');
  profile.id = 'org.libretro.parallel-dc';
  f.saved.defaultProfileId = profile.id;
  let changes = 0;
  const settings = createEmulatorSettings(f.client, () => {
    changes++;
  });
  await settings.load();
  const file = new Blob([new Uint8Array(32)]);
  assert.equal(await settings.installSystemFile('operator', 'awbios.zip', file), false);
  assert.equal(await settings.installSystemFile('disabled', 'awbios.zip', file), false);
  assert.equal(await settings.installSystemFile(profile.id, '../awbios.zip', file), false);
  assert.equal(await settings.installSystemFile(profile.id, 'dc_boot.bin', file), false);
  assert.equal(await settings.installSystemFile(profile.id, 'awbios.zip', new Blob()), false);
  assert.equal(
    await settings.installSystemFile(
      profile.id,
      'awbios.zip',
      new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]),
    ),
    false,
  );
  assert.deepEqual(f.calls, ['read']);
  assert.equal(await settings.installSystemFile(profile.id, 'AWBIOS.ZIP', file), true);
  assert.equal(
    await settings.installSystemFile(profile.id, 'awbios.zip', new Blob([new Uint8Array(48)])),
    true,
  );
  assert.deepEqual(f.calls, [
    'read',
    'system:org.libretro.parallel-dc:awbios.zip:32',
    'system:org.libretro.parallel-dc:awbios.zip:48',
  ]);
  assert.equal(changes, 2);
  assert.equal(get(settings).listing?.items[0]?.profile.assets.length, 1);
  assert.equal(get(settings).listing?.items[0]?.profile.assets[0]?.name, 'awbios.zip');
  assert.equal(get(settings).listing?.items[0]?.profile.assets[0]?.sizeBytes, 48);
});

test('system-file authorization failures clear management details and notify the owner session', async () => {
  const f = fixture();
  const profile = f.saved.items[0]?.profile;
  if (!profile) throw new Error('Missing fixture');
  profile.id = 'org.libretro.parallel-dc';
  f.saved.defaultProfileId = profile.id;
  const rejected: number[] = [];
  f.client.installPlayerSystemFile = async () => {
    throw new ContentError(403, null);
  };
  const settings = createEmulatorSettings(
    f.client,
    () => {},
    (status) => {
      rejected.push(status);
    },
  );
  await settings.load();
  assert.equal(
    await settings.installSystemFile(profile.id, 'awbios.zip', new Blob([new Uint8Array(32)])),
    false,
  );
  assert.deepEqual(rejected, [403]);
  assert.equal(get(settings).listing, null);
});
