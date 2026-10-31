import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type ControllerLayout,
  defaultLayout,
  fitLayout,
  transformRect,
  validateLayout,
} from '../src/player/layout.js';

test('procedural layouts share screen/control geometry and equal outer insets', () => {
  const doc = defaultLayout('compact');
  validateLayout(doc);
  const p = doc.representations.portrait;
  const left = p.controls.find((c) => c.action === 'left')!,
    a = p.controls.find((c) => c.action === 'a')!,
    b = p.controls.find((c) => c.action === 'b')!;
  assert.equal(left.frame.x, p.reference.width - a.frame.x - a.frame.width);
  assert.equal(a.frame.width, b.frame.width);
  const fit = fitLayout(p.reference, 720, 1040);
  assert.deepEqual(transformRect(p.screens[0]!.frame, fit), {
    x: 0,
    y: 0,
    width: 720,
    height: 540,
  });
});
test('layout rejects non-finite, oversized, invisible and path-bearing values', () => {
  for (const mutate of [
    (d: ControllerLayout) => (d.representations.portrait.controls[0]!.frame.x = NaN),
    (d: ControllerLayout) => (d.representations.portrait.controls[0]!.frame.width = 9999),
    (d: ControllerLayout) => (d.representations.portrait.controls[0]!.opacity = 0),
    (d: ControllerLayout) => (d.assets = [{ id: '../evil', mediaType: 'image/png' }]),
    (d: ControllerLayout) =>
      (d.representations.portrait.controls = Array(33).fill(
        d.representations.portrait.controls[0],
      )),
  ]) {
    const d = defaultLayout('compact');
    mutate(d);
    assert.throws(() => validateLayout(d));
  }
});
test('image references and source crop frames survive the same layout model as procedural shapes', () => {
  const d = defaultLayout('compact');
  d.assets = [{ id: 'portrait-art', mediaType: 'image/png' }];
  d.representations.portrait.artwork = [
    { assetId: 'portrait-art', frame: { x: 0, y: 0, width: 360, height: 520 } },
  ];
  d.representations.portrait.controls[0]!.visual = { kind: 'image', assetId: 'portrait-art' };
  d.representations.portrait.screens[0]!.inputFrame = { x: 0, y: 0, width: 1, height: 1 };
  assert.deepEqual(validateLayout(JSON.parse(JSON.stringify(d))), d);
});
test('switching placement reserves game space and preserves control sizes and horizontal insets', async () => {
  const { setLayoutPlacement } = await import('../src/player/layout.js');
  const r = defaultLayout('standard').representations.landscape,
    under = setLayoutPlacement(r, 'underlay');
  validateLayout({
    ...defaultLayout('standard'),
    representations: { portrait: defaultLayout().representations.portrait, landscape: under },
  });
  assert.ok(under.controls.every((c) => c.frame.y >= under.screens[0]!.frame.height));
  assert.deepEqual(
    under.controls.map((c) => [c.frame.x, c.frame.width, c.frame.height]),
    r.controls.map((c) => [c.frame.x, c.frame.width, c.frame.height]),
  );
  const over = setLayoutPlacement(under, 'overlay');
  assert.equal(over.screens[0]!.frame.height, over.reference.height);
  assert.deepEqual(over.controls, under.controls);
});
test('built-in standard controls do not cover each other in either orientation', () => {
  for (const r of Object.values(defaultLayout('standard').representations))
    for (let i = 0; i < r.controls.length; i++)
      for (let j = i + 1; j < r.controls.length; j++) {
        const a = r.controls[i]!,
          b = r.controls[j]!,
          x =
            Math.min(a.frame.x + a.frame.width, b.frame.x + b.frame.width) -
            Math.max(a.frame.x, b.frame.x),
          y =
            Math.min(a.frame.y + a.frame.height, b.frame.y + b.frame.height) -
            Math.max(a.frame.y, b.frame.y);
        assert.ok(x <= 0 || y <= 0, `${a.id} overlaps ${b.id}`);
      }
});
