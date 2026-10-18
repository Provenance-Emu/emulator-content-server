import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { canStart, canStop, createServiceControl, type ServiceInvoke } from '../src/lib/service.js';

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
