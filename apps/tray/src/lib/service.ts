import { writable } from 'svelte/store';

export type ServiceState = 'unknown' | 'absent' | 'running' | 'stopped' | 'starting' | 'stopping';
export type ServiceInvoke = (command: string) => Promise<string>;
export interface ServiceSnapshot {
  native: boolean;
  state: ServiceState;
  busy: boolean;
  failure: string | null;
}

export function canStart(snapshot: ServiceSnapshot): boolean {
  return snapshot.native && !snapshot.busy && snapshot.state === 'stopped';
}

export function canStop(snapshot: ServiceSnapshot): boolean {
  return (
    snapshot.native &&
    !snapshot.busy &&
    (snapshot.state === 'running' || snapshot.state === 'starting')
  );
}

/** Local registration state is independent of whichever HTTP address is watched. */
export function createServiceControl(
  invoke: ServiceInvoke | null,
  changed: () => Promise<void> = async () => {},
) {
  let current: ServiceSnapshot = {
    native: invoke !== null,
    state: 'unknown',
    busy: false,
    failure: null,
  };
  const store = writable(current);
  function update(patch: Partial<ServiceSnapshot>) {
    current = { ...current, ...patch };
    store.set(current);
  }
  async function run(command: string, refresh: boolean) {
    if (!invoke || current.busy) return;
    update({ busy: true });
    try {
      const reply = await invoke(command);
      if (!['absent', 'running', 'stopped', 'starting', 'stopping'].includes(reply)) {
        throw new Error('The service manager returned an unexpected status.');
      }
      update({ state: reply as ServiceState, failure: null });
    } catch (error) {
      update({
        state: 'unknown',
        failure: error instanceof Error ? error.message : String(error),
      });
    } finally {
      update({ busy: false });
    }
    if (refresh) void changed().catch(() => {});
  }
  return {
    subscribe: store.subscribe,
    check: () => run('service_status', false),
    start: async () => {
      if (canStart(current)) await run('service_start', true);
    },
    stop: async () => {
      if (canStop(current)) await run('service_stop', true);
    },
  };
}

export type ServiceControl = ReturnType<typeof createServiceControl>;
export function serviceSummary(snapshot: ServiceSnapshot): string {
  if (!snapshot.native) return 'Service controls are available in the desktop tray.';
  if (snapshot.failure) return 'Local service unavailable';
  if (snapshot.busy) return 'Checking or changing local service…';
  const labels: Record<ServiceState, string> = {
    unknown: 'Checking local service…',
    absent: 'Local service is not installed',
    running: 'Local service running',
    stopped: 'Local service stopped',
    starting: 'Local service starting…',
    stopping: 'Local service stopping…',
  };
  return labels[snapshot.state];
}
