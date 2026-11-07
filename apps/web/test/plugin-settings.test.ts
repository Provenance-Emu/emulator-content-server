import assert from 'node:assert/strict';
import test from 'node:test';
import { ContentError, type PluginManagement } from '@ecs/client';
import { get } from 'svelte/store';
import { createPluginSettings } from '../src/lib/plugin-settings.js';

function fixture() {
  const view: PluginManagement = {
    available: true,
    hostId: null,
    running: false,
    error: null,
    items: [],
    defaults: [],
  };
  let installs = 0;
  const client = {
    pluginManagement: async () => view,
    installDefaultPlugins: async () => {
      installs++;
      return view;
    },
    configurePlugin: async () => view,
    doctorPlugins: async () => view,
    matchingPlugins: async () => ({ plugins: [] }),
    workflowHosts: async () => ({ items: [] }),
  };
  return { view, client, installs: () => installs };
}
test('uncertain plugin installs require a refresh before another mutation', async () => {
  const f = fixture();
  f.client.installDefaultPlugins = async () => {
    throw new TypeError('network');
  };
  const store = createPluginSettings(f.client, () => {});
  await store.load();
  await store.installDefaults();
  assert.equal(get(store).needsRefresh, true);
  assert.equal(get(store).message, null);
  f.client.installDefaultPlugins = async () => {
    throw new Error('must not retry');
  };
  await store.installDefaults();
  assert.equal(get(store).failure, 'The server is unreachable.');
  await store.load();
  assert.equal(get(store).needsRefresh, false);
  store.dispose();
});
test('owner session loss clears plugin data and disposal rejects late results', async () => {
  const f = fixture();
  const denied: number[] = [];
  const store = createPluginSettings(f.client, (status) => denied.push(status));
  await store.load();
  f.client.doctorPlugins = async () => {
    throw new ContentError(403, null);
  };
  await store.doctor();
  assert.equal(get(store).listing, null);
  assert.equal(get(store).denied, true);
  assert.deepEqual(denied, [403]);
  const next = fixture();
  let release!: (value: PluginManagement) => void;
  next.client.pluginManagement = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const disposed = createPluginSettings(next.client, () => {});
  const loading = disposed.load();
  disposed.dispose();
  release(next.view);
  await loading;
  assert.equal(get(disposed).listing, null);
});
