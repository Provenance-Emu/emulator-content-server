import assert from 'node:assert/strict';
import test from 'node:test';
import { groupDiscs } from '../src/disc-groups.js';
import type { ScannedFile } from '../src/scan.js';

const row = (relativePath: string, systemId = 'com.provenance.naomi'): ScannedFile => ({
  relativePath,
  displayName: relativePath.split('/').at(-1) ?? relativePath,
  size: 8,
  blocks: 1,
  kind: 'rom',
  systemId,
  availability: 'local',
});

test('NAOMI and NAOMI 2 ZIPs group their GD-ROMs without reading archive or disc bytes', async () => {
  for (const system of ['com.provenance.naomi', 'com.provenance.naomi2']) {
    const files = [row('private/cart.zip', system), row('private/cart/gdrom.chd', system)];
    await groupDiscs('/no-files-are-opened', files);
    assert.deepEqual(files[0]?.groupMembers, ['private/cart.zip', 'private/cart/gdrom.chd']);
    assert.equal(files[0]?.groupError, null);
    assert.equal(files[1]?.groupAnchor, 'private/cart.zip');
  }
});

test('cartridge ZIPs stay standalone and Dreamcast files are not grouped as NAOMI sets', async () => {
  const files = [
    row('cart.zip'),
    row('dc.zip', 'com.provenance.dreamcast'),
    row('dc/disc.chd', 'com.provenance.dreamcast'),
  ];
  await groupDiscs('/unused', files);
  assert.ok(
    files.every((file) => !file.groupMembers?.length && !file.groupAnchor && !file.groupError),
  );
});

test('MAME ZIPs group only same-system CHDs in the matching set directory', async () => {
  const mame = 'com.provenance.mame';
  const files = [
    row('collection/game.zip', mame),
    row('collection/game/disc.chd', mame),
    row('collection/game/other-system.chd'),
    row('collection/game/nested/another.chd', mame),
    row('collection/parent.zip', mame),
    row('collection/unrelated/disc.chd', mame),
  ];
  await groupDiscs('/unused', files);
  assert.deepEqual(files[0]?.groupMembers, ['collection/game.zip', 'collection/game/disc.chd']);
  assert.equal(files[1]?.groupAnchor, 'collection/game.zip');
  assert.ok(files.slice(2).every((file) => !file.groupMembers?.length && !file.groupAnchor));
});

test('a missing previously scanned GD-ROM stays required across rescans', async () => {
  const files = [row('cart.zip')];
  const previous = new Map([['cart.zip', ['cart.zip', 'cart/gdrom.chd']]]);
  await groupDiscs('/unused', files, undefined, previous);
  assert.deepEqual(files[0]?.groupMembers, ['cart.zip', 'cart/gdrom.chd']);
  assert.match(files[0]?.groupError ?? '', /missing/i);
  await groupDiscs('/unused', files);
  assert.match(files[0]?.groupError ?? '', /missing/i);
});

test('an unavailable GD-ROM makes its group incomplete and does not become another game', async () => {
  const files = [row('cart.zip'), { ...row('cart/gdrom.chd'), availability: 'evicted' as const }];
  await groupDiscs('/unused', files);
  assert.equal(files[1]?.groupAnchor, 'cart.zip');
  assert.deepEqual(files[0]?.groupMembers, ['cart.zip', 'cart/gdrom.chd']);
  assert.ok(files[0]?.groupError);
});

test('unique casing is retained and ambiguous arcade ZIP names reject their group', async () => {
  const files = [row('Cart.ZIP'), row('cart/GDROM.CHD')];
  await groupDiscs('/unused', files);
  assert.deepEqual(files[0]?.groupMembers, ['Cart.ZIP', 'cart/GDROM.CHD']);
  const ambiguous = [row('cart.zip'), row('CART.ZIP'), row('cart/gdrom.chd')];
  await groupDiscs('/unused', ambiguous);
  assert.ok(ambiguous.every((file) => file.groupError));
});

test('a remaining known GD-ROM reports a missing ZIP primary', async () => {
  const files = [row('cart/gdrom.chd')];
  await groupDiscs(
    '/unused',
    files,
    undefined,
    new Map([['cart.zip', ['cart.zip', 'cart/gdrom.chd']]]),
  );
  assert.match(files[0]?.groupError ?? '', /missing/i);
  await groupDiscs('/unused', files);
  assert.match(files[0]?.groupError ?? '', /missing/i);
});

test('oversized arcade groups stay within protocol bounds and report an error', async () => {
  const files = [
    row('cart.zip'),
    ...Array.from({ length: 512 }, (_, i) => row(`cart/disc-${i}.chd`)),
  ];
  await groupDiscs('/unused', files);
  assert.equal(files[0]?.groupMembers?.length, 512);
  assert.match(files[0]?.groupError ?? '', /too many/i);
  assert.ok(files.slice(1).every((file) => file.groupAnchor === 'cart.zip'));
});
