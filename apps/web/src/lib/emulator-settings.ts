import {
  type ContentClient,
  ContentError,
  isPlayerSystemFileName,
  type PlayerConfiguration,
  type PlayerManagement,
} from '@ecs/client';
import { writable } from 'svelte/store';
import { explain, isForbidden, isUnauthorized } from './problems.js';

export type EmulatorManagementClient = Pick<
  ContentClient,
  | 'playerManagement'
  | 'installPlayer'
  | 'installPlayerPackage'
  | 'installPlayerSystemFile'
  | 'configurePlayer'
  | 'removePlayer'
>;
interface EmulatorSettingsState {
  listing: PlayerManagement | null;
  busy: boolean;
  activity: string | null;
  failure: string | null;
  message: string | null;
  denied: boolean;
  needsRefresh: boolean;
}

/** Management never loads emulator code, follows artifact URLs, or starts background installs. */
export function createEmulatorSettings(
  client: EmulatorManagementClient,
  changed: () => void | Promise<void> = () => {},
  onrejected: (status: 401 | 403) => void = () => {},
) {
  let current: EmulatorSettingsState = {
    listing: null,
    busy: false,
    activity: null,
    failure: null,
    message: null,
    denied: false,
    needsRefresh: false,
  };
  const store = writable(current);
  let disposed = false;
  let catalogNeedsRefresh = false;
  const canChange = () =>
    !disposed && !current.busy && !!current.listing && !current.denied && !current.needsRefresh;
  function update(patch: Partial<EmulatorSettingsState>) {
    if (disposed) return;
    current = { ...current, ...patch };
    store.set(current);
  }
  function fail(error: unknown, saved: boolean, mutation: boolean) {
    if (disposed) return;
    if (isUnauthorized(error) || isForbidden(error)) {
      catalogNeedsRefresh = false;
      const status = isUnauthorized(error) ? 401 : 403;
      update({
        listing: null,
        denied: true,
        needsRefresh: false,
        message: null,
        failure:
          status === 403
            ? 'Sign in with the server owner account to manage emulators. Local network access alone cannot install or change them.'
            : 'Sign in again with the server owner account to manage emulators.',
      });
      onrejected(status);
      return;
    }
    if (error instanceof ContentError && error.status === 404 && !saved) {
      if (mutation) catalogNeedsRefresh = true;
      update({
        listing: null,
        message: null,
        needsRefresh: true,
        failure: mutation
          ? `Refresh emulators and try again. ${explain(error)}`
          : 'Emulator management is not available on this server. Refresh emulators or check the server version.',
      });
      return;
    }
    const uncertain =
      mutation && (!(error instanceof ContentError) || error.status >= 500 || error.status === 408);
    if (uncertain || saved) catalogNeedsRefresh = true;
    update({
      failure: saved
        ? `Change saved, but the player catalog could not be refreshed. Refresh emulators before another change. ${explain(error)}`
        : uncertain
          ? `The server could not confirm the change. Refresh emulators before trying again. ${explain(error)}`
          : explain(error),
      message: null,
      needsRefresh: saved || uncertain || current.needsRefresh,
    });
  }
  async function notifyCatalog() {
    if (disposed || !catalogNeedsRefresh) return;
    await changed();
    if (!disposed) catalogNeedsRefresh = false;
  }
  async function mutate(
    action: () => Promise<PlayerManagement>,
    activity: string,
    message: string,
  ) {
    if (!canChange()) return false;
    update({ busy: true, activity, failure: null, message: null });
    let saved = false;
    try {
      const listing = await action();
      if (disposed) return false;
      saved = true;
      catalogNeedsRefresh = true;
      update({ listing, denied: false });
      await notifyCatalog();
      update({ message, needsRefresh: false });
      return !disposed;
    } catch (error) {
      fail(error, saved, true);
      return saved && !disposed;
    } finally {
      update({ busy: false, activity: null });
    }
  }
  return {
    subscribe: store.subscribe,
    async load() {
      if (disposed || current.busy) return false;
      update({ busy: true, activity: 'Reading emulators…', failure: null, message: null });
      try {
        const listing = await client.playerManagement();
        if (disposed) return false;
        update({ listing, denied: false });
        await notifyCatalog();
        update({ needsRefresh: false });
        return !disposed;
      } catch (error) {
        fail(error, false, false);
        return false;
      } finally {
        update({ busy: false, activity: null });
      }
    },
    install(id: string) {
      const entry = current.listing?.available.find((entry) => entry.id === id);
      if (
        !canChange() ||
        !entry?.available ||
        current.listing?.items.some((item) => item.profile.id === id)
      )
        return Promise.resolve(false);
      return mutate(
        () => client.installPlayer(id),
        `Installing ${entry.name}…`,
        `${entry.name} installed. Changes apply the next time a game starts.`,
      );
    },
    installPackage(file: Blob, name: string) {
      if (!canChange()) return Promise.resolve(false);
      if (!/\.ecsplayer$/i.test(name) || file.size < 4) {
        update({
          failure: 'Choose a non-empty .ecsplayer package, then click Install package.',
          message: null,
        });
        return Promise.resolve(false);
      }
      return mutate(
        () => client.installPlayerPackage(file),
        'Installing emulator package…',
        'Emulator package installed. Manage it under Installed.',
      );
    },
    installSystemFile(id: string, name: string, file: Blob) {
      const item = current.listing?.items.find((item) => item.profile.id === id);
      if (!canChange() || item?.source !== 'managed' || item.profile.runtime === 'dolphin-wasm-esm')
        return Promise.resolve(false);
      const canonicalName =
        id === 'org.libretro.parallel-dc' && name.toLowerCase() === 'awbios.zip'
          ? 'awbios.zip'
          : name;
      if (!isPlayerSystemFileName(canonicalName) || file.size < 1 || file.size > 32 * 1024 * 1024) {
        update({
          failure: 'Choose a system file with a portable filename, from 1 byte to 32 MiB.',
          message: null,
        });
        return Promise.resolve(false);
      }
      return mutate(
        () => client.installPlayerSystemFile(id, canonicalName, file),
        'Installing system file…',
        'System file installed. It will be used the next time a game starts.',
      );
    },
    configure(id: string, configuration: PlayerConfiguration) {
      const item = current.listing?.items.find((item) => item.profile.id === id);
      if (
        !canChange() ||
        item?.source !== 'managed' ||
        (configuration.default && !(configuration.enabled ?? item.enabled))
      )
        return Promise.resolve(false);
      const changes =
        (configuration.enabled !== undefined && configuration.enabled !== item.enabled) ||
        (configuration.default !== undefined &&
          configuration.default !== (current.listing?.defaultProfileId === id));
      if (!changes) return Promise.resolve(false);
      return mutate(
        () => client.configurePlayer(id, configuration),
        'Saving emulator settings…',
        'Emulator settings saved. Changes apply the next time a game starts.',
      );
    },
    remove(id: string) {
      const item = current.listing?.items.find((item) => item.profile.id === id);
      if (!canChange() || item?.source !== 'managed' || !item.removable)
        return Promise.resolve(false);
      return mutate(
        () => client.removePlayer(id),
        `Removing ${item.profile.name}…`,
        `${item.profile.name} removed. Your games remain in the library.`,
      );
    },
    dispose() {
      disposed = true;
      catalogNeedsRefresh = false;
      current = {
        ...current,
        listing: null,
        busy: false,
        activity: null,
        failure: null,
        message: null,
      };
      store.set(current);
    },
  };
}
