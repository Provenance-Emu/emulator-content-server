import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyTheme, readTheme, saveTheme } from '../src/lib/theme.js';

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

test('an unknown or missing saved theme follows the system', () => {
  assert.equal(readTheme(memory()), 'system');
  assert.equal(readTheme(memory({ 'ecs.theme': 'sepia' })), 'system');
  assert.equal(readTheme(memory({ 'ecs.theme': 'light' })), 'light');
});

test('an explicit theme is stored and set on the root, and system clears both', () => {
  const storage = memory();
  const root = { dataset: {} as Record<string, string | undefined> };
  saveTheme('dark', storage, root);
  assert.equal(storage.values.get('ecs.theme'), 'dark');
  assert.equal(root.dataset.theme, 'dark');
  saveTheme('system', storage, root);
  assert.equal(storage.values.has('ecs.theme'), false);
  assert.equal('theme' in root.dataset, false);
});

test('blocked storage still applies the choice to the page', () => {
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  const root = { dataset: {} as Record<string, string | undefined> };
  assert.equal(readTheme(blocked), 'system');
  saveTheme('light', blocked, root);
  assert.equal(root.dataset.theme, 'light');
  applyTheme('system', root);
  assert.equal('theme' in root.dataset, false);
});
