import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputPreferences } from '../src/player/input-preferences.js';
import { InputSession } from '../src/player/input-session.js';
import { PresentationGate } from '../src/player/presentation.js';
import type { PlayerRuntime } from '../src/player/runtime.js';
import { fixture } from './player-fixture.js';

function setup() {
  const packets: { active: boolean }[] = [];
  const input = new InputSession(
    { sendInput: (p: { active: boolean }) => packets.push(p) } as unknown as PlayerRuntime,
    createInputPreferences('https://ecs.test', fixture().core, undefined, {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    }),
  );
  input.ready = true;
  return { input, packets };
}
test('a leave dialog holds mapped input neutral across later focus heartbeats', () => {
  const { input, packets } = setup(),
    gate = new PresentationGate(() => input);
  input.heartbeat(true);
  assert.equal(packets.at(-1)?.active, true);
  assert.equal(gate.acquire('leave'), true);
  input.heartbeat(true);
  assert.equal(packets.at(-1)?.active, false);
  gate.release('leave');
  input.heartbeat(true);
  assert.equal(packets.at(-1)?.active, true);
});
test('duplicate AirPlay opening cannot overwrite the original gate or reopen after release', () => {
  const { input } = setup(),
    gate = new PresentationGate(() => input);
  assert.equal(gate.acquire('airplay'), true);
  assert.equal(gate.acquire('airplay'), false);
  gate.release('airplay');
  assert.equal(input.presentationBusy, false);
  assert.equal(gate.has('airplay'), false);
  gate.release('airplay');
  assert.equal(input.presentationBusy, false);
});
test('overlapping dialogs and pre-existing skin suspension remain correctly scoped', () => {
  const { input } = setup(),
    gate = new PresentationGate(() => input);
  gate.acquire('airplay');
  gate.acquire('leave');
  gate.release('airplay');
  assert.equal(input.presentationBusy, true);
  gate.release('leave');
  assert.equal(input.presentationBusy, false);
  input.presentationBusy = true;
  gate.acquire('airplay');
  gate.release('airplay');
  assert.equal(input.presentationBusy, true);
  input.presentationBusy = false;
  gate.acquire('leave');
  gate.dispose();
  assert.equal(input.presentationBusy, false);
});
