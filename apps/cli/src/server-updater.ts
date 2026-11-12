import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ServerUpdateDecision,
  ServerUpdateHistoryEntry,
  ServerUpdateSettings,
  ServerUpdateStatus,
} from '@ecs/protocol';
import type { ServerUpdates } from '@ecs/server';
import { type Build, isBuild, readJson, readUpdateState, writeJson } from './update-files.js';
import { findUpdate, stageUpdate, type UpdateCandidate } from './update-release.js';

const checkInterval = 60 * 60_000;
const snoozeDuration = 24 * checkInterval;

interface Preferences {
  settings: ServerUpdateSettings;
  skipped: string[];
  snoozed?: { id: string; until: number };
}
interface UpdateActivity {
  history: ServerUpdateHistoryEntry[];
  lastCheck?: { channel: Build['channel']; at: string };
}

function validHistoryEntry(entry: ServerUpdateHistoryEntry): boolean {
  return (
    !!entry?.build &&
    typeof entry.build.version === 'string' &&
    ['release', 'nightly'].includes(entry.build.channel) &&
    ['installed', 'observed', 'rolled-back'].includes(entry.outcome) &&
    Number.isFinite(Date.parse(entry.at))
  );
}

export class ServerUpdater implements ServerUpdates {
  private phase: ServerUpdateStatus['phase'] = 'idle';
  private message?: string;
  private available?: UpdateCandidate;
  private timer?: NodeJS.Timeout;
  private failed?: string;
  private readonly abort = new AbortController();
  private saving = false;
  private task?: Promise<void>;
  private activityWrite = Promise.resolve();

  private constructor(
    private readonly directory: string,
    private readonly current: Build,
    private preferences: Preferences,
    private activity: UpdateActivity,
    private readonly activation: {
      at: string;
      installed: boolean;
      trial: boolean;
      failedBuild?: Build;
    },
    private readonly restart: (id: string) => Promise<void>,
    private readonly source: { find: typeof findUpdate; stage: typeof stageUpdate },
  ) {}

  static async open(
    directory: string,
    current: Build,
    restart: (id: string) => Promise<void>,
    source = { find: findUpdate, stage: stageUpdate },
  ): Promise<ServerUpdater> {
    let unreadable = false;
    const value = (await readJson(join(directory, 'preferences.json')).catch(() => {
      unreadable = true;
      return undefined;
    })) as Preferences | undefined;
    const settings = value?.settings;
    const preferences: Preferences =
      settings &&
      ['release', 'nightly'].includes(settings.channel) &&
      ['off', 'manual', 'automatic'].includes(settings.mode)
        ? { ...value, settings, skipped: Array.isArray(value.skipped) ? value.skipped : [] }
        : { settings: { channel: current.channel, mode: 'off' }, skipped: [] };
    const statePath = join(directory, 'state.json');
    const [saved, state, stateFile] = await Promise.all([
      readJson(join(directory, 'activity.json')).catch(() => undefined) as Promise<
        Partial<UpdateActivity> | undefined
      >,
      readUpdateState(directory).catch(() => undefined),
      stat(statePath).catch(() => undefined),
    ]);
    const failedBuild = state?.failed
      ? await readJson(join(directory, 'builds', state.failed, 'BUILD.json')).catch(() => undefined)
      : undefined;
    const updater = new ServerUpdater(
      directory,
      current,
      preferences,
      {
        history: Array.isArray(saved?.history)
          ? saved.history.slice(0, 20).filter(validHistoryEntry)
          : [],
        ...(saved?.lastCheck && Number.isFinite(Date.parse(saved.lastCheck.at))
          ? { lastCheck: saved.lastCheck }
          : {}),
      },
      {
        at:
          state?.active === current.id && !state.failed && stateFile
            ? stateFile.mtime.toISOString()
            : new Date().toISOString(),
        trial: state?.pending === current.id,
        installed:
          state?.pending === current.id ||
          (state?.active === current.id && !state.failed && !!stateFile),
        ...(isBuild(failedBuild) ? { failedBuild } : {}),
      },
      restart,
      source,
    );
    if (unreadable)
      updater.message = 'Update preferences could not be read. Update checks are off.';
    return updater;
  }

  status(): ServerUpdateStatus {
    const { settings } = this.preferences;
    const available = this.available?.build;
    return {
      supported: true,
      settings,
      current: publicBuild(this.current),
      ...(available ? { available: publicBuild(available) } : {}),
      phase: this.phase,
      prompt:
        settings.mode === 'manual' &&
        this.phase === 'idle' &&
        Boolean(available && !this.suppressed(available)),
      ...(this.message ? { message: this.message } : {}),
      ...(this.activity.lastCheck?.channel === settings.channel
        ? { lastCheckedAt: this.activity.lastCheck.at }
        : {}),
      history: this.activity.history,
    };
  }

  start(failed?: string): void {
    this.failed = failed;
    if (failed) this.message = 'The last update failed to start. The previous build was restored.';
    const lastActive = this.activity.history.find((entry) => entry.outcome !== 'rolled-back');
    if (lastActive?.build.id !== this.current.id) {
      this.activity.history.unshift({
        build: publicBuild(this.current),
        at: this.activation.trial ? new Date().toISOString() : this.activation.at,
        outcome: this.activation.installed ? 'installed' : 'observed',
      });
      this.saveActivity();
    }
    const failedBuild = this.activation.failedBuild;
    if (failedBuild && failedBuild.id === failed && this.activity.history[0]?.build.id !== failed) {
      this.activity.history.unshift({
        build: publicBuild(failedBuild),
        at: this.activation.at,
        outcome: 'rolled-back',
      });
      this.saveActivity();
    }
    this.check();
    this.timer = setInterval(() => this.check(), checkInterval);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.abort.abort();
    await this.task;
    await this.activityWrite;
  }

  private saveActivity(): void {
    this.activity.history = this.activity.history.slice(0, 20);
    const snapshot = structuredClone(this.activity);
    this.activityWrite = this.activityWrite
      .then(() => writeJson(join(this.directory, 'activity.json'), snapshot))
      .catch(() => {});
  }

  deferRestart(): void {
    if (this.phase !== 'restarting') return;
    this.phase = 'idle';
    this.message = 'Another server command is running. Try the update again shortly.';
  }

  async configure(settings: ServerUpdateSettings): Promise<ServerUpdateStatus> {
    if (this.saving || this.phase === 'downloading' || this.phase === 'restarting')
      return this.status();
    await this.save({ ...this.preferences, settings });
    this.available = undefined;
    this.message = undefined;
    this.check();
    return this.status();
  }

  async decide(decision: ServerUpdateDecision): Promise<ServerUpdateStatus> {
    if (this.saving || this.preferences.settings.mode === 'off') return this.status();
    if (decision.action === 'check') {
      this.check();
      return this.status();
    }
    const update = this.available;
    if (this.phase !== 'idle' || !update || update.build.id !== decision.buildId)
      return this.status();
    if (decision.action === 'install') {
      this.task = this.install(update);
    } else if (decision.action === 'skip') {
      await this.save({
        ...this.preferences,
        skipped: [...new Set([...this.preferences.skipped, update.build.id])].slice(-128),
      });
    } else {
      await this.save({
        ...this.preferences,
        snoozed: { id: update.build.id, until: Date.now() + snoozeDuration },
      });
    }
    return this.status();
  }

  private async save(preferences: Preferences): Promise<void> {
    this.saving = true;
    try {
      await writeJson(join(this.directory, 'preferences.json'), preferences);
      this.preferences = preferences;
    } finally {
      this.saving = false;
    }
  }

  private suppressed(build: Build): boolean {
    const { skipped, snoozed } = this.preferences;
    return (
      build.id === this.failed ||
      skipped.includes(build.id) ||
      (snoozed?.id === build.id && Date.now() < snoozed.until)
    );
  }

  private check(): void {
    const { mode, channel } = this.preferences.settings;
    if (this.abort.signal.aborted || this.saving || this.phase !== 'idle' || mode === 'off') return;
    this.phase = 'checking';
    this.task = this.checkChannel(channel);
  }

  private async checkChannel(channel: Build['channel']): Promise<void> {
    try {
      const update = await this.source.find(channel, this.current, this.abort.signal);
      // A preference change can complete while GitHub is responding.
      const { mode, channel: selected } = this.preferences.settings;
      if (this.saving || selected !== channel || mode === 'off' || this.abort.signal.aborted)
        return;
      this.checked(channel);
      this.available = update;
      this.message =
        update?.build.id === this.failed && this.failed !== undefined
          ? 'This build failed to start. It can be retried manually.'
          : undefined;
      if (mode === 'automatic' && update && !this.suppressed(update.build))
        await this.install(update);
    } catch (error) {
      if (
        !this.abort.signal.aborted &&
        this.preferences.settings.channel === channel &&
        this.preferences.settings.mode !== 'off'
      ) {
        this.checked(channel);
        this.message = (error as Error).message;
      }
    } finally {
      if (this.phase === 'checking') {
        this.phase = 'idle';
        if (this.preferences.settings.channel !== channel) this.check();
      }
    }
  }

  private checked(channel: Build['channel']): void {
    this.activity.lastCheck = { channel, at: new Date().toISOString() };
    this.saveActivity();
  }

  private async install(update: UpdateCandidate): Promise<void> {
    this.phase = 'downloading';
    this.message = undefined;
    try {
      await this.source.stage(this.directory, update, this.abort.signal);
      this.abort.signal.throwIfAborted();
      this.phase = 'restarting';
      await this.restart(update.build.id);
    } catch (error) {
      this.phase = 'idle';
      if (!this.abort.signal.aborted) this.message = (error as Error).message;
    }
  }
}

function publicBuild({ id, version, channel, builtAt }: Build): ServerUpdateHistoryEntry['build'] {
  return { id, version, channel, builtAt };
}
