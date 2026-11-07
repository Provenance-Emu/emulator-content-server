import {
  type ContentClient,
  ContentError,
  type ManagedWorkflowPlugin,
  type MatchingPlugin,
  type PluginManagement,
  type WorkflowHost,
} from '@ecs/client';
import { writable } from 'svelte/store';
import { explain } from './problems.js';

type PluginClient = Pick<
  ContentClient,
  | 'pluginManagement'
  | 'installDefaultPlugins'
  | 'configurePlugin'
  | 'doctorPlugins'
  | 'matchingPlugins'
  | 'workflowHosts'
>;
interface PluginSettingsState {
  listing: PluginManagement | null;
  providers: MatchingPlugin[];
  hosts: WorkflowHost[];
  busy: boolean;
  failure: string | null;
  integrationsFailure: string | null;
  message: string | null;
  needsRefresh: boolean;
  denied: boolean;
}
export function createPluginSettings(client: PluginClient, rejected: (status: 401 | 403) => void) {
  let state: PluginSettingsState = {
    listing: null,
    providers: [],
    hosts: [],
    busy: false,
    failure: null,
    integrationsFailure: null,
    message: null,
    needsRefresh: false,
    denied: false,
  };
  const store = writable(state);
  let disposed = false;
  function emit(patch: Partial<PluginSettingsState>) {
    if (disposed) return;
    state = { ...state, ...patch };
    store.set(state);
  }
  function failure(error: unknown, mutation: boolean) {
    if (disposed) return;
    if (error instanceof ContentError && (error.status === 401 || error.status === 403)) {
      emit({
        listing: null,
        providers: [],
        hosts: [],
        denied: true,
        needsRefresh: false,
        failure: 'Sign in with the server owner account to manage plugins.',
        message: null,
      });
      rejected(error.status);
      return;
    }
    emit({
      failure:
        error instanceof ContentError && error.status === 404
          ? 'Update this server to use plugin management in Settings.'
          : explain(error),
      needsRefresh: mutation || (error instanceof ContentError && error.status === 404),
      ...(error instanceof ContentError && error.status === 404 ? { listing: null } : {}),
      message: null,
    });
  }
  async function integrations() {
    const [providers, hosts] = await Promise.all([
      client.matchingPlugins(),
      client.workflowHosts(),
    ]);
    emit({
      providers: providers.plugins,
      hosts: hosts.items.filter((host) => !host.revokedAt),
      integrationsFailure: null,
    });
  }
  async function run(
    operation: () => Promise<PluginManagement>,
    mutation: boolean,
    message: string | null,
  ) {
    if (
      disposed ||
      state.busy ||
      (mutation && (state.denied || state.needsRefresh || !state.listing?.available))
    )
      return;
    emit({ busy: true, failure: null, message: null });
    try {
      const listing = await operation();
      if (disposed) return;
      emit({ listing, denied: false, needsRefresh: false, message });
      try {
        await integrations();
      } catch (error) {
        if (error instanceof ContentError && (error.status === 401 || error.status === 403))
          failure(error, false);
        else emit({ integrationsFailure: explain(error) });
      }
    } catch (error) {
      failure(error, mutation);
    } finally {
      emit({ busy: false });
    }
  }
  return {
    subscribe: store.subscribe,
    load: () => run(() => client.pluginManagement(), false, null),
    installDefaults: () =>
      run(
        () => client.installDefaultPlugins(),
        true,
        'Bundled plugins installed and connected to this server.',
      ),
    configure: (plugin: ManagedWorkflowPlugin) =>
      run(
        () =>
          client.configurePlugin({
            id: plugin.id,
            digest: plugin.digest,
            enabled: !plugin.enabled,
          }),
        true,
        plugin.enabled ? 'Plugin disabled.' : 'Plugin enabled and connected.',
      ),
    doctor: () =>
      run(
        () => client.doctorPlugins(),
        true,
        'Package validation and host connection checks passed.',
      ),
    dispose() {
      disposed = true;
    },
  };
}
