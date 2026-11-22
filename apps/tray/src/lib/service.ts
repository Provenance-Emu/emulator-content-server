import { writable } from 'svelte/store';

export type ServiceState =
  | 'unknown'
  | 'absent'
  | 'running'
  | 'stopped'
  | 'starting'
  | 'stopping'
  /** The login registration names a server build that is no longer installed. */
  | 'broken'
  /** Registered, but the server keeps exiting. */
  | 'failing'
  | 'boot-running'
  | 'boot-stopped';
export type ServiceInvoke = (command: string) => Promise<string>;
export interface ServiceSnapshot {
  native: boolean;
  state: ServiceState;
  busy: boolean;
  failure: string | null;
}

const STATES: ServiceState[] = [
  'absent',
  'running',
  'stopped',
  'starting',
  'stopping',
  'broken',
  'failing',
  'boot-running',
  'boot-stopped',
];
const ready = (snapshot: ServiceSnapshot) => snapshot.native && !snapshot.busy;

export function canStart(snapshot: ServiceSnapshot): boolean {
  return ready(snapshot) && ['stopped', 'boot-stopped'].includes(snapshot.state);
}

export function canStop(snapshot: ServiceSnapshot): boolean {
  return (
    ready(snapshot) && ['running', 'starting', 'failing', 'boot-running'].includes(snapshot.state)
  );
}

export function canRestart(snapshot: ServiceSnapshot): boolean {
  return (
    ready(snapshot) && ['running', 'starting', 'failing', 'boot-running'].includes(snapshot.state)
  );
}

/**
 * Registering the login service again is offered whenever one exists, and when its state
 * could not be read: that is exactly when someone needs a way out.
 */
export function canRepair(snapshot: ServiceSnapshot): boolean {
  return ready(snapshot) && !['absent', 'boot-running', 'boot-stopped'].includes(snapshot.state);
}

/** The service is installed for the whole computer; its controls ask for an administrator. */
export function isBootService(snapshot: ServiceSnapshot): boolean {
  return snapshot.state === 'boot-running' || snapshot.state === 'boot-stopped';
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
  async function ask(command: string): Promise<ServiceState> {
    if (!invoke) throw new Error('Service controls are available in the desktop tray.');
    const reply = await invoke(command);
    if (!STATES.includes(reply as ServiceState)) {
      throw new Error('The service manager returned an unexpected status.');
    }
    return reply as ServiceState;
  }
  const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
  async function run(command: string, refresh: boolean) {
    if (!invoke || current.busy) return;
    update({ busy: true });
    try {
      const state = await ask(command);
      // The ten-second status poll does not wipe the reason an action just failed.
      const unchanged = command === 'service_status' && state === current.state;
      update({ state, failure: unchanged ? current.failure : null });
    } catch (error) {
      const failure = text(error);
      // A failed action says why, and the controls go back to what the service really is,
      // so the next step (try again, repair) is still there to press.
      let state: ServiceState = 'unknown';
      if (command !== 'service_status') {
        try {
          state = await ask('service_status');
        } catch {
          // The first failure is the one worth reading.
        }
      }
      update({ state, failure });
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
    restart: async () => {
      if (canRestart(current)) await run('service_restart', true);
    },
    repair: async () => {
      if (canRepair(current)) await run('service_repair', true);
    },
  };
}

export type ServiceControl = ReturnType<typeof createServiceControl>;
export function serviceSummary(snapshot: ServiceSnapshot): string {
  if (!snapshot.native) return 'Service controls are available in the desktop tray.';
  if (snapshot.busy) return 'Checking or changing local service…';
  if (snapshot.failure && snapshot.state === 'unknown') return 'Local service unavailable';
  const labels: Record<ServiceState, string> = {
    unknown: 'Checking local service…',
    absent: 'Local service is not installed',
    running: 'Local service running',
    stopped: 'Local service stopped',
    starting: 'Local service starting…',
    stopping: 'Local service stopping…',
    broken: 'Local service needs repair',
    failing: 'Local service keeps stopping',
    'boot-running': 'Boot service running',
    'boot-stopped': 'Boot service stopped',
  };
  return labels[snapshot.state];
}
