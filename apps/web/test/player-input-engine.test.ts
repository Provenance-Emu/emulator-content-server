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
