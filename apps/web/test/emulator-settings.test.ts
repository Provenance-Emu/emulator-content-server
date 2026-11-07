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

test('managed ordinary profiles accept portable system files while operator and Dolphin uploads stay unavailable', async () => {
  const f = fixture();
  const dolphin = playerProfile('org.example.dolphin');
  dolphin.runtime = 'dolphin-wasm-esm';
  dolphin.threaded = true;
  f.saved.items.push({ profile: dolphin, enabled: true, source: 'managed', removable: true });
  let changes = 0;
  const settings = createEmulatorSettings(f.client, () => {
    changes++;
  });
  await settings.load();
  const file = new Blob([new Uint8Array(32)]);
  assert.equal(await settings.installSystemFile('operator', 'bios.bin', file), false);
  assert.equal(await settings.installSystemFile(dolphin.id, 'bios.bin', file), false);
  for (const name of ['../bios.bin', 'retroarch.cfg', 'CON.rom', 'loader.js']) {
    assert.equal(await settings.installSystemFile('managed', name, file), false);
  }
  assert.equal(await settings.installSystemFile('managed', 'bios.bin', new Blob([])), false);
  assert.equal(
    await settings.installSystemFile(
      'managed',
      'bios.bin',
      new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]),
    ),
    false,
  );
  assert.deepEqual(f.calls, ['read']);
  assert.equal(await settings.installSystemFile('managed', 'BIOS.ROM', file), true);
  assert.equal(
    await settings.installSystemFile('disabled', 'disksys.fds', file),
    true,
    'disabled managed profiles can be prepared before enabling',
  );
  assert.deepEqual(f.calls, [
    'read',
    'system:managed:BIOS.ROM:32',
    'system:disabled:disksys.fds:32',
  ]);
  assert.equal(changes, 2);
  assert.equal(get(settings).listing?.items[0]?.profile.assets[0]?.name, 'BIOS.ROM');
});

test('Atomiswave archive names retain their existing canonical spelling', async () => {
  const f = fixture();
  const profile = f.saved.items[0]?.profile;
  if (!profile) throw new Error('Missing fixture');
  profile.id = 'org.libretro.parallel-dc';
  const settings = createEmulatorSettings(f.client);
  await settings.load();
  assert.equal(
    await settings.installSystemFile(profile.id, 'AWBIOS.ZIP', new Blob([new Uint8Array(32)])),
    true,
  );
  assert.deepEqual(f.calls, ['read', 'system:org.libretro.parallel-dc:awbios.zip:32']);
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

function batchFixture() {
  const f = fixture();
  const available = f.saved.available[0];
  assert.ok(available);
  f.saved.available = Array.from({ length: 6 }, (_, index) => ({
    ...available,
    id: `core-${index}`,
    name: `Core ${index}`,
  }));
  return f;
}

test('bulk installs use three workers, ignore stale mutation snapshots and reconcile once', async () => {
  const f = batchFixture();
  const finishes = new Map<string, () => void>();
  const originalInstall = f.client.installPlayer;
  let active = 0;
  let maximum = 0;
  f.client.installPlayer = async (id) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => finishes.set(id, resolve));
    await originalInstall(id);
    active--;
    return playerManagementFixture();
  };
  let changes = 0;
  const settings = createEmulatorSettings(f.client, () => {
    changes++;
  });
  await settings.load();
  const pending = settings.installMany([
    'core-0',
    'core-0',
    'missing',
    ...f.saved.available.slice(1).map((entry) => entry.id),
  ]);
  assert.equal(finishes.size, 3);
  assert.equal(get(settings).batch?.items.filter((item) => item.status === 'running').length, 3);
  finishes.get('core-2')?.();
  await new Promise((resolve) => setImmediate(resolve));
  finishes.get('core-3')?.();
  await new Promise((resolve) => setImmediate(resolve));
  finishes.get('core-4')?.();
  await new Promise((resolve) => setImmediate(resolve));
  finishes.get('core-5')?.();
  finishes.get('core-1')?.();
  finishes.get('core-0')?.();
  assert.equal(await pending, true);
  assert.equal(maximum, 3);
  assert.equal(get(settings).listing?.items.length, 9);
  assert.equal(get(settings).listing?.defaultProfileId, 'managed');
  assert.equal(get(settings).batch?.items.filter((item) => item.status === 'succeeded').length, 6);
  assert.equal(get(settings).batch?.items.filter((item) => item.status === 'skipped').length, 1);
  assert.equal(changes, 1);
  assert.equal(f.calls.filter((call) => call === 'read').length, 2);
});

test('bulk item rejection is isolated and removal skips operator and missing entries', async () => {
  const f = batchFixture();
  const install = f.client.installPlayer;
  f.client.installPlayer = async (id) => {
    if (id === 'core-1')
      throw new ContentError(409, {
        type: 'urn:ecs:conflict',
        title: 'Generated conflict',
        status: 409,
      });
    return install(id);
  };
  const settings = createEmulatorSettings(f.client);
  await settings.load();
  await settings.installMany(f.saved.available.map((entry) => entry.id));
  assert.equal(get(settings).batch?.items.filter((item) => item.status === 'failed').length, 1);
  assert.equal(get(settings).batch?.items.filter((item) => item.status === 'succeeded').length, 5);
  assert.match(get(settings).batch?.items[1]?.detail ?? '', /Generated conflict/);
  await settings.removeMany(['managed', 'operator', 'missing', 'disabled', 'managed']);
  assert.equal(get(settings).batch?.items.filter((item) => item.status === 'succeeded').length, 2);
  assert.equal(get(settings).batch?.items.filter((item) => item.status === 'skipped').length, 2);
  assert.equal(f.calls.includes('remove:operator'), false);
});

for (const status of [401, 403, 404, 500] as const) {
  test(`bulk ${status} stops queued writes and preserves rejection or refresh requirements`, async () => {
    const f = batchFixture();
    const writes: string[] = [];
    const finishes: Array<() => void> = [];
    f.client.installPlayer = async (id) => {
      writes.push(id);
      if (id === 'core-0') throw new ContentError(status, null);
      await new Promise<void>((resolve) => {
        finishes.push(resolve);
      });
      return structuredClone(f.saved);
    };
    const rejected: number[] = [];
    const settings = createEmulatorSettings(
      f.client,
      () => {},
      (status) => rejected.push(status),
    );
    await settings.load();
    const pending = settings.installMany(f.saved.available.map((entry) => entry.id));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes.length, 3);
    finishes.forEach((finish) => {
      finish();
    });
    await pending;
    assert.equal(get(settings).batch?.items.filter((item) => item.status === 'skipped').length, 3);
    assert.equal(get(settings).denied, status === 401 || status === 403);
    assert.equal(get(settings).needsRefresh, status === 404 || status === 500);
    assert.deepEqual(rejected, status === 401 || status === 403 ? [status] : []);
  });
}

test('disposing a batch suppresses queued writes, reconciliation and callbacks', async () => {
  const f = batchFixture();
  const finishes: Array<() => void> = [];
  let writes = 0;
  let changes = 0;
  f.client.installPlayer = async () => {
    writes++;
    await new Promise<void>((resolve) => finishes.push(resolve));
    return structuredClone(f.saved);
  };
  const settings = createEmulatorSettings(f.client, () => {
    changes++;
  });
  await settings.load();
  const pending = settings.installMany(f.saved.available.map((entry) => entry.id));
  settings.dispose();
  finishes.forEach((finish) => {
    finish();
  });
  assert.equal(await pending, false);
  assert.equal(writes, 3);
  assert.equal(changes, 0);
  assert.deepEqual(f.calls, ['read']);
});

test('stopping queued work waits for active requests and performs one reconciliation', async () => {
  const f = batchFixture();
  const finishes: Array<() => void> = [];
  const install = f.client.installPlayer;
  f.client.installPlayer = async (id) => {
    await new Promise<void>((resolve) => finishes.push(resolve));
    return install(id);
  };
  let changes = 0;
  const settings = createEmulatorSettings(f.client, () => {
    changes++;
  });
  await settings.load();
  const pending = settings.installMany(f.saved.available.map((entry) => entry.id));
  settings.stopBatch();
  assert.equal(get(settings).busy, true);
  finishes.forEach((finish) => {
    finish();
  });
  await pending;
  assert.equal(get(settings).batch?.items.filter((item) => item.status === 'skipped').length, 3);
  assert.equal(get(settings).batch?.items.filter((item) => item.status === 'succeeded').length, 3);
  assert.equal(changes, 1);
  assert.equal(f.calls.filter((call) => call === 'read').length, 2);
});

test('authorization rejection takes precedence over an earlier uncertain batch failure', async () => {
  const f = batchFixture();
  const finishes = new Map<string, () => void>();
  f.client.installPlayer = async (id) => {
    await new Promise<void>((resolve) => finishes.set(id, resolve));
    throw new ContentError(id === 'core-0' ? 500 : 403, null);
  };
  const rejected: number[] = [];
  let changes = 0;
  const settings = createEmulatorSettings(
    f.client,
    () => {
      changes++;
    },
    (status) => rejected.push(status),
  );
  await settings.load();
  const pending = settings.installMany(f.saved.available.map((entry) => entry.id));
  finishes.get('core-0')?.();
  await new Promise((resolve) => setImmediate(resolve));
  finishes.get('core-1')?.();
  finishes.get('core-2')?.();
  await pending;
  assert.equal(get(settings).denied, true);
  assert.equal(get(settings).listing, null);
  assert.equal(get(settings).needsRefresh, false);
  assert.deepEqual(rejected, [403]);
  assert.equal(changes, 0);
  assert.deepEqual(f.calls, ['read']);
});

test('a failed batch catalog callback requires refresh without retrying any installs', async () => {
  const f = batchFixture();
  let changes = 0;
  const settings = createEmulatorSettings(f.client, () => {
    changes++;
    if (changes === 1) throw new Error('Generated catalog offline');
  });
  await settings.load();
  await settings.installMany(['core-0', 'core-1']);
  assert.equal(get(settings).needsRefresh, true);
  assert.match(get(settings).failure ?? '', /saved.*catalog.*refreshed/i);
  assert.equal(await settings.installMany(['core-2']), false);
  await settings.load();
  assert.equal(changes, 2);
  assert.equal(get(settings).needsRefresh, false);
  assert.equal(f.calls.filter((call) => call.startsWith('install:')).length, 2);
});
