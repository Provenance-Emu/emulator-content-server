import type {
  ContentClient,
  ServerUpdateDecision,
  ServerUpdateSettings,
  ServerUpdateStatus,
} from '@ecs/client';
import { ContentError } from '@ecs/client';
import { writable } from 'svelte/store';

export interface UpdateView {
  status?: ServerUpdateStatus;
  working: boolean;
  error?: string;
}

export function createServerUpdates(client: ContentClient) {
  let view: UpdateView = { working: false };
  const store = writable(view);
  let timer: ReturnType<typeof setTimeout>;
  let running = false;
  let generation = 0;
  let polling = false;

  function set(next: Partial<UpdateView>) {
    view = { ...view, ...next };
    store.set(view);
  }

  function schedule() {
    clearTimeout(timer);
    if (!running) return;
    const phase = view.status?.phase;
    timer = setTimeout(() => void refresh(), phase && phase !== 'idle' ? 1500 : 15_000);
  }

  async function refresh() {
    if (view.working || polling) return schedule();
    const epoch = generation;
    polling = true;
    try {
      const status = await client.serverUpdates();
      if (running && epoch === generation) set({ status });
    } catch (error) {
      if (
        running &&
        epoch === generation &&
        error instanceof ContentError &&
        [401, 403, 404].includes(error.status)
      ) {
        set({ status: undefined });
      }
    } finally {
      polling = false;
      schedule();
    }
  }

  async function change(request: () => Promise<ServerUpdateStatus>) {
    if (!running || view.working) return;
    const epoch = ++generation;
    set({ working: true, error: undefined });
    try {
      const status = await request();
      if (running && epoch === generation) set({ status });
    } catch (error) {
      if (running && epoch === generation) set({ error: (error as Error).message });
    } finally {
      if (running && epoch === generation) set({ working: false });
      schedule();
    }
  }

  return {
    subscribe: store.subscribe,
    start() {
      running = true;
      void refresh();
      return () => {
        generation++;
        running = false;
        clearTimeout(timer);
        view = { working: false };
        store.set(view);
      };
    },
    configure: (settings: ServerUpdateSettings) =>
      change(() => client.configureServerUpdates(settings)),
    decide: (action: ServerUpdateDecision['action'], buildId?: string) =>
      change(() => client.decideServerUpdate({ action, buildId })),
  };
}

export type ServerUpdatesView = ReturnType<typeof createServerUpdates>;
