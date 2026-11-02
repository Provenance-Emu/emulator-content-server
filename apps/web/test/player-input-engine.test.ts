import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputEngine } from '../src/player/input-engine.js';

test('separate sources OR buttons, resolve opposing directions, and preserve a short tap for a native poll', () => {
  const e = createInputEngine();
  e.packet({ sequence: 1, active: true, sources: [] }, 0);
  e.source('key', 0, 256, [0, 0, 0, 0]);
  e.source('touch', 0, 256, [0, 0, 0, 0]);
  e.clear('key', true);
  assert.equal(e.sample(0).buttons, 256);
  e.afterFrame();
  e.clear('touch', true);
  assert.equal(e.sample(0).buttons, 0);
  e.source('tap', 0, 256, [0, 0, 0, 0]);
  e.clear('tap');
  assert.equal(e.sample(0).buttons, 256);
  e.afterFrame();
  assert.equal(e.sample(0).buttons, 0);
  e.source('left', 0, 64, [0.4, 0, 0, 0]);
  e.source('right', 0, 128, [-0.4, 0, 0, 0]);
  assert.equal(e.sample(0).buttons, 0);
  assert.equal(e.sample(0).axes[0], 0);
});
test('watchdog/inactive and invalid packets release all input, stale packets cannot resurrect it', () => {
  const e = createInputEngine();
  e.packet({ sequence: 1, active: true, sources: [] }, 0);
  e.packet(
    {
      sequence: 2,
      active: true,
      sources: [{ id: 'p1', port: 0, buttons: 256, axes: [0, 0, 0, 0] }],
    },
    1,
  );
  assert.equal(e.sample(0).buttons, 256);
  e.tick(800);
  assert.equal(e.sample(0).buttons, 0);
  e.packet(
    {
      sequence: 2,
      active: true,
      sources: [{ id: 'p1', port: 0, buttons: 256, axes: [0, 0, 0, 0] }],
    },
    801,
  );
  assert.equal(e.sample(0).buttons, 0);
  e.packet(
    {
      sequence: 3,
      active: true,
      sources: [{ id: 'p1', port: 0, buttons: 256, axes: [0, 0, 0, 0] }],
    },
    802,
  );
  assert.equal(e.sample(0).buttons, 0, 'must first return neutral');
  assert.throws(() =>
    e.packet(
      {
        sequence: 4,
        active: true,
        sources: [{ id: 'p', port: 9, buttons: 1, axes: [0, 0, 0, 0] }],
      },
      803,
    ),
  );
  assert.equal(e.sample(0).buttons, 0);
});
test('a fresh centered owned stick can rearm after watchdog expiry without replaying held input', () => {
  const e = createInputEngine();
  const owned = (x: number) => [{ id: 'finger', port: 0, buttons: 0, axes: [x, 0, 0, 0] }];
  e.packet({ sequence: 1, active: true, sources: [] }, 0);
  e.packet({ sequence: 2, active: true, sources: owned(0.8) }, 1);
  assert.equal(e.sample(0).axes[0], 0.8);
  e.tick(800);
  assert.equal(e.active, false);
  assert.deepEqual(e.sample(0), { buttons: 0, axes: [0, 0, 0, 0] });
  e.packet({ sequence: 2, active: true, sources: owned(0) }, 801);
  assert.equal(e.active, false, 'a stale neutral packet cannot rearm');
  e.packet({ sequence: 3, active: true, sources: owned(0.8) }, 802);
  assert.equal(e.active, false, 'a fresh but held stick cannot rearm');
  assert.equal(e.sample(0).axes[0], 0);
  e.packet({ sequence: 4, active: true, sources: owned(0) }, 803);
  assert.equal(e.active, true, 'centering is neutral even while the pointer remains owned');
  assert.equal(e.sample(0).axes[0], 0);
  e.packet({ sequence: 5, active: true, sources: owned(0.8) }, 804);
  assert.equal(e.sample(0).axes[0], 0.8);
});
test('watchdog rearm requires each source to be neutral, rather than cancelling held states', () => {
  const e = createInputEngine();
  e.packet({ sequence: 1, active: true, sources: [] }, 0);
  e.tick(800);
  e.packet(
    {
      sequence: 2,
      active: true,
      sources: [
        { id: 'left', port: 0, buttons: 0, axes: [-0.8, 0, 0, 0] },
        { id: 'right', port: 0, buttons: 0, axes: [0.8, 0, 0, 0] },
      ],
    },
    801,
  );
  assert.equal(e.active, false);
  e.packet(
    {
      sequence: 3,
      active: true,
      sources: [
        { id: 'finger', port: 0, buttons: 0, axes: [0, 0, 0, 0] },
        { id: 'held', port: 1, buttons: 256, axes: [0, 0, 0, 0] },
      ],
    },
    802,
  );
  assert.equal(e.active, false);
  assert.deepEqual(e.sample(1), { buttons: 0, axes: [0, 0, 0, 0] });
  e.packet(
    {
      sequence: 4,
      active: true,
      sources: [
        { id: 'finger', port: 0, buttons: 0, axes: [0, 0, 0, 0] },
        { id: 'held', port: 1, buttons: 0, axes: [0, 0, 0, 0] },
      ],
    },
    803,
  );
  assert.equal(e.active, true);
});
test('explicit lifecycle loss and invalid packets still require an empty packet to rearm', () => {
  const e = createInputEngine();
  const centered = [{ id: 'finger', port: 0, buttons: 0, axes: [0, 0, 0, 0] }];
  e.packet({ sequence: 1, active: true, sources: [] }, 0);
  e.tick(800);
  e.packet({ sequence: 2, active: false, sources: [] }, 801);
  e.tick(1600);
  e.packet({ sequence: 3, active: true, sources: centered }, 1601);
  assert.equal(e.active, false);
  e.tick(2400);
  e.packet({ sequence: 4, active: true, sources: centered }, 2401);
  assert.equal(e.active, false, 'timing out while disarmed cannot override lifecycle loss');
  e.packet({ sequence: 5, active: true, sources: [] }, 2402);
  assert.equal(e.active, true);
  e.tick(3200);
  assert.throws(() =>
    e.packet(
      {
        sequence: 6,
        active: true,
        sources: [{ id: 'invalid', port: 4, buttons: 0, axes: [0, 0, 0, 0] }],
      },
      3201,
    ),
  );
  e.packet({ sequence: 7, active: true, sources: centered }, 3202);
  assert.equal(e.active, false, 'invalid input removes watchdog-only rearm permission');
  e.packet({ sequence: 8, active: true, sources: [] }, 3203);
  assert.equal(e.active, true);
});
test('ordinary release revokes watchdog recovery and preserving it cannot create permission', () => {
  const e = createInputEngine();
  const centered = [{ id: 'finger', port: 0, buttons: 0, axes: [0, 0, 0, 0] }];
  e.release(true);
  e.packet({ sequence: 1, active: true, sources: centered }, 0);
  assert.equal(e.active, false, 'preserve before a valid expiry grants nothing');
  e.packet({ sequence: 2, active: true, sources: [] }, 1);
  e.tick(800);
  e.release(true);
  e.packet({ sequence: 3, active: true, sources: centered }, 801);
  assert.equal(e.active, true, 'watchdog cleanup can retain existing recovery permission');
  e.tick(1600);
  e.release();
  e.release(true);
  e.packet({ sequence: 4, active: true, sources: centered }, 1601);
  assert.equal(e.active, false, 'ordinary release revokes permission permanently');
  e.packet({ sequence: 5, active: true, sources: [] }, 1602);
  assert.equal(e.active, true);
});
test('cancel removes pending tap only for its own pointer and abandoned IDs cannot grow unbounded', () => {
  const e = createInputEngine();
  e.packet({ sequence: 1, active: true, sources: [] }, 0);
  e.source('key', 0, 256, [0, 0, 0, 0]);
  e.packet(
    {
      sequence: 2,
      active: true,
      sources: [{ id: 'finger', port: 0, buttons: 256, axes: [0, 0, 0, 0] }],
    },
    1,
  );
  e.packet({ sequence: 3, active: true, sources: [], cancelled: ['finger'] }, 2);
  assert.equal(e.sample(0).buttons, 256);
  e.clear('key', true);
  assert.equal(e.sample(0).buttons, 0);
  assert.throws(() => {
    for (let n = 0; n < 150; n++) {
      e.source(`touch:${n}`, 0, 256, [0, 0, 0, 0]);
      e.clear(`touch:${n}`);
    }
  }, /limit/i);
});
test('touch sticks share the configured deadzone and logical axis inversion', async () => {
  const { touchStickAxes, defaultMapping } = await import('../src/player/input-model.js');
  const map = defaultMapping().ports[0]!;
  map.axes[0]!.inverted = true;
  map.axes[3]!.inverted = true;
  const left = touchStickAxes(0.575, 0.1, false, map),
    right = touchStickAxes(0, 0.575, true, map);
  assert.ok(Math.abs((left[0] ?? 0) + 0.5) < 1e-12);
  assert.deepEqual(left.slice(1), [0, 0, 0]);
  assert.deepEqual(right.slice(0, 3), [0, 0, 0]);
  assert.ok(Math.abs((right[3] ?? 0) + 0.5) < 1e-12);
});
