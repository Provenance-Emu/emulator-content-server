import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Windows native resource icon is checked in and listed for bundling', async () => {
  const root = new URL('../../../src-tauri/', import.meta.url);
  const icon = await readFile(new URL('icons/icon.ico', root));
  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.ok(icon.readUInt16LE(4) > 0);
  const config = JSON.parse(await readFile(new URL('tauri.conf.json', root), 'utf8'));
  assert.ok(config.bundle.icon.includes('icons/icon.ico'));
});
