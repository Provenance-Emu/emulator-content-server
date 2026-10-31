import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GameWindowLaunch,
  gameWindowUrl,
  readGameWindowSelection,
  validateWindowSaves,
} from '../src/player/windows.js';

const selection = {
  item: 'item-1',
  asset: 'rom-1',
  profile: 'core-1',
  battery: 'battery-1',
  state: 'state-1',
};
test('game window carries only bounded known selection fields and never consent or credentials', () => {
  const url = new URL(
    gameWindowUrl('https://ecs.test', {
      ...selection,
      token: 'secret',
      compatible: true,
    } as typeof selection),
  );
  assert.equal(url.origin, 'https://ecs.test');
  assert.equal(url.pathname, '/play/');
  assert.equal(url.searchParams.get('gameWindow'), '1');
  assert.equal(url.searchParams.has('token'), false);
  assert.equal(url.searchParams.has('compatible'), false);
  assert.deepEqual(readGameWindowSelection(url.searchParams), selection);
  assert.equal(readGameWindowSelection(new URLSearchParams('item=x&asset=y')), null);
});
test('ambiguous and oversized window selections reject before a window opens', () => {
  for (const s of [
    { ...selection, source: 'source-1' },
    { profile: 'x', asset: 'rom-1' },
    { ...selection, item: '\n' },
    { ...selection, profile: 'x'.repeat(513) },
  ])
    assert.throws(() => gameWindowUrl('https://ecs.test', s));
  assert.throws(() =>
    readGameWindowSelection(new URLSearchParams('gameWindow=1&item=a&item=b&asset=c&profile=d')),
  );
  assert.throws(() => gameWindowUrl('javascript:alert(1)', selection));
});
test('copied save IDs must still belong to the selected target and match their kinds', () => {
  validateWindowSaves(selection, [
    { id: 'battery-1', kind: 'battery_save' },
    { id: 'state-1', kind: 'save_state' },
  ]);
  assert.throws(() =>
    validateWindowSaves(selection, [
      { id: 'battery-1', kind: 'rom' },
      { id: 'state-1', kind: 'save_state' },
    ]),
  );
  assert.throws(() => validateWindowSaves(selection, []));
  assert.throws(() =>
    validateWindowSaves({ source: 'source-1', profile: 'core', state: 'state-1' }, [
      { id: 'state-1', kind: 'save_state' },
    ]),
  );
});
test('blocked launches preserve setup and a live window cannot be launched twice', () => {
  const launch = new GameWindowLaunch();
  let calls = 0;
  const child = { closed: false, opener: {} };
  assert.equal(
    launch.open('/play/', () => null),
    false,
  );
  assert.equal(launch.opened, false);
  assert.match(launch.error ?? '', /blocked/i);
  assert.equal(
    launch.open('/play/', () => {
      calls++;
      return child;
    }),
    true,
  );
  assert.equal(child.opener, null);
  assert.equal(launch.opened, true);
  assert.equal(
    launch.open('/play/', () => {
      calls++;
      return child;
    }),
    false,
  );
  assert.equal(calls, 1);
  launch.checkClosed();
  assert.equal(launch.opened, true);
  child.closed = true;
  launch.checkClosed();
  assert.equal(launch.opened, false);
});
test('an uncertain window stays locked, and parent disposal never closes the child', () => {
  const launch = new GameWindowLaunch();
  let closed = false;
  launch.open('/play/', () => ({
    get closed() {
      if (!closed) throw Error('isolated');
      return false;
    },
    opener: null,
    close() {
      closed = true;
    },
  }));
  launch.checkClosed();
  assert.equal(launch.opened, true);
  launch.dispose();
  assert.equal(closed, false);
  const failed = new GameWindowLaunch();
  assert.equal(
    failed.open('/play/', () => {
      throw Error('blocked');
    }),
    false,
  );
  assert.equal(failed.opened, false);
});

test('source launches retain the explicit save target without manufacturing an asset selection', () => {
  const selection = { source: 'source-1', item: 'item-2', profile: 'core-1', state: 'state-3' };
  const url = new URL(gameWindowUrl('https://ecs.test', selection));
  assert.deepEqual(readGameWindowSelection(url.searchParams), selection);
  assert.equal(url.searchParams.has('asset'), false);
});
