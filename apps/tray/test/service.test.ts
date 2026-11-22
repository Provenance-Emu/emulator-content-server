import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import {
  canRepair,
  canRestart,
  canStart,
  canStop,
  createServiceControl,
  type ServiceInvoke,
  serviceSummary,
} from '../src/lib/service.js';

test('a browser cannot invoke service commands', async () => {
  const service = createServiceControl(null);
  await service.check();
  await service.start();
  await service.stop();
  assert.equal(canStart(get(service)), false);
  assert.equal(canStop(get(service)), false);
});

test('an installed stopped service can start even when HTTP is offline', async () => {
  const calls: string[] = [];
  let checks = 0;
  const service = createServiceControl(
    async (command) => {
      calls.push(command);
      return command === 'service_status' ? 'stopped' : 'starting';
    },
    async () => {
      checks++;
    },
  );
  await service.check();
  assert.equal(canStart(get(service)), true);
  assert.equal(canStop(get(service)), false);
  await service.start();
  assert.deepEqual(calls, ['service_status', 'service_start']);
  assert.equal(get(service).state, 'starting');
  assert.equal(checks, 1);
});

test('an absent registration disables controls and cannot be started', async () => {
  const calls: string[] = [];
  const service = createServiceControl(async (command) => {
    calls.push(command);
    return 'absent';
  });
  await service.check();
  await service.start();
  await service.stop();
  assert.deepEqual(calls, ['service_status']);
  assert.equal(get(service).state, 'absent');
});

test('duplicate actions and polling cannot race an operation', async () => {
  const calls: string[] = [];
  let complete: (value: string) => void = () => {};
  const invoke: ServiceInvoke = async (command) => {
    calls.push(command);
    if (command === 'service_status') return 'running';
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  const service = createServiceControl(invoke);
  await service.check();
  const stopping = service.stop();
  assert.equal(get(service).busy, true);
  assert.equal(canStart(get(service)), false);
  assert.equal(canStop(get(service)), false);
  await service.stop();
  await service.check();
  assert.deepEqual(calls, ['service_status', 'service_stop']);
  complete('stopping');
  await stopping;
  assert.equal(get(service).state, 'stopping');
  assert.equal(get(service).busy, false);
});

test('manager errors disable controls until a successful refresh', async () => {
  let failing = false;
  const service = createServiceControl(async () => {
    if (failing) throw new Error('service manager unavailable');
    return 'running';
  });
  await service.check();
  failing = true;
  await service.stop();
  assert.match(get(service).failure ?? '', /service manager unavailable/);
  assert.equal(get(service).state, 'unknown');
  assert.equal(canStop(get(service)), false);
  failing = false;
  await service.check();
  assert.equal(get(service).failure, null);
  assert.equal(canStop(get(service)), true);
});

test('unexpected native replies are errors, never an actionable service state', async () => {
  const service = createServiceControl(async () => 'unexpected');
  await service.check();
  assert.equal(get(service).state, 'unknown');
  assert.ok(get(service).failure);
  assert.equal(canStart(get(service)), false);
});

test('a slow HTTP refresh never keeps local service actions pending', async () => {
  let refreshing = false;
  const service = createServiceControl(
    async (command) => (command === 'service_status' ? 'stopped' : 'starting'),
    async () => {
      refreshing = true;
      return new Promise<void>(() => {});
    },
  );
  await service.check();
  const finished = await Promise.race([
    service.start().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(refreshing, true);
  assert.equal(finished, true);
  assert.equal(get(service).busy, false);
});

test('a failed action says why and leaves the controls on what the service really is', async () => {
  const calls: string[] = [];
  const service = createServiceControl(async (command) => {
    calls.push(command);
    if (command === 'service_stop') throw new Error('launchctl bootout failed (code 5).');
    return 'running';
  });
  await service.check();
  await service.stop();
  assert.deepEqual(calls, ['service_status', 'service_stop', 'service_status']);
  assert.match(get(service).failure ?? '', /bootout failed/);
  assert.equal(get(service).state, 'running');
  assert.equal(canStop(get(service)), true);
  assert.equal(canRestart(get(service)), true);
  assert.equal(canRepair(get(service)), true);
  assert.equal(serviceSummary(get(service)), 'Local service running');
  // The routine status poll keeps the reason on screen; the next action replaces it.
  await service.check();
  assert.match(get(service).failure ?? '', /bootout failed/);
  await service.restart();
  assert.equal(get(service).failure, null);
});

test('a registration whose server build is gone offers repair, and repair re-reads the state', async () => {
  const calls: string[] = [];
  let repaired = false;
  let refreshed = 0;
  const service = createServiceControl(
    async (command) => {
      calls.push(command);
      if (command === 'service_repair') repaired = true;
      return repaired ? 'running' : 'broken';
    },
    async () => {
      refreshed++;
    },
  );
  await service.check();
  assert.equal(serviceSummary(get(service)), 'Local service needs repair');
  assert.equal(canStart(get(service)), false);
  assert.equal(canRestart(get(service)), false);
  assert.equal(canRepair(get(service)), true);
  await service.start();
  await service.repair();
  assert.deepEqual(calls, ['service_status', 'service_repair']);
  assert.equal(get(service).state, 'running');
  assert.equal(refreshed, 1);
});

test('a service that keeps stopping can be restarted, stopped or repaired', async () => {
  const calls: string[] = [];
  const service = createServiceControl(async (command) => {
    calls.push(command);
    return command === 'service_status' ? 'failing' : 'starting';
  });
  await service.check();
  assert.equal(serviceSummary(get(service)), 'Local service keeps stopping');
  assert.equal(canStop(get(service)), true);
  assert.equal(canRepair(get(service)), true);
  await service.restart();
  assert.deepEqual(calls, ['service_status', 'service_restart']);
});

test('the boot service starts, stops and restarts, and is never repaired from the tray', async () => {
  let state = 'boot-stopped';
  const calls: string[] = [];
  const service = createServiceControl(async (command) => {
    calls.push(command);
    if (command === 'service_start' || command === 'service_restart') state = 'boot-running';
    if (command === 'service_stop') state = 'boot-stopped';
    return state;
  });
  await service.check();
  assert.equal(canStart(get(service)), true);
  assert.equal(canStop(get(service)), false);
  assert.equal(canRepair(get(service)), false);
  await service.start();
  assert.equal(get(service).state, 'boot-running');
  assert.equal(canRestart(get(service)), true);
  await service.restart();
  await service.repair();
  await service.stop();
  assert.deepEqual(calls, ['service_status', 'service_start', 'service_restart', 'service_stop']);
  assert.equal(get(service).state, 'boot-stopped');
});

test('with no readable state, repair is still offered', async () => {
  const service = createServiceControl(async () => {
    throw new Error('Could not contact or control your per-user service manager.');
  });
  await service.check();
  assert.equal(get(service).state, 'unknown');
  assert.equal(canStart(get(service)), false);
  assert.equal(canRepair(get(service)), true);
});
