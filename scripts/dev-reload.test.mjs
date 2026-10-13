import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldRestart } from './dev-reload.mjs';

test('a compiled server or package restarts the process', () => {
  assert.equal(shouldRestart('apps/server/dist/src/routes.js'), true);
  assert.equal(shouldRestart('apps/cli/dist/src/main.js'), true);
  assert.equal(shouldRestart('packages/database/dist/src/catalog.js'), true);
});

test('the web build and everything that is not compiled output stay up', () => {
  assert.equal(shouldRestart('apps/web/dist/assets/index-abc.js'), false);
  assert.equal(shouldRestart('apps/tray/dist/assets/index-abc.js'), false);
  assert.equal(shouldRestart('apps/server/src/routes.ts'), false);
  assert.equal(shouldRestart('packages/database/dist/.tsbuildinfo'), false);
});
