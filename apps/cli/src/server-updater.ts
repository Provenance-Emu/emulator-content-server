import { join } from 'node:path';
import type { ServerUpdateDecision, ServerUpdateSettings, ServerUpdateStatus } from '@ecs/protocol';
import type { ServerUpdates } from '@ecs/server';
import { type Build, readJson, writeJson } from './update-files.js';
import { findUpdate, stageUpdate, type UpdateCandidate } from './update-release.js';

const checkInterval = 60 * 60_000;
const snoozeDuration = 24 * checkInterval;

interface Preferences {
  settings: ServerUpdateSettings;
  skipped: string[];
  snoozed?: { id: string; until: number };
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

  private constructor(
    private readonly directory: string,
    private readonly current: Build,
    private preferences: Preferences,
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
    const updater = new ServerUpdater(directory, current, preferences, restart, source);
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
    };
  }

  start(failed?: string): void {
    this.failed = failed;
    if (failed) this.message = 'The last update failed to start. The previous build was restored.';
    this.check();
    this.timer = setInterval(() => this.check(), checkInterval);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.abort.abort();
    await this.task;
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
      this.available = update;
      this.message =
        update?.build.id === this.failed && this.failed !== undefined
          ? 'This build failed to start. It can be retried manually.'
          : undefined;
      if (mode === 'automatic' && update && !this.suppressed(update.build))
        await this.install(update);
    } catch (error) {
      if (!this.abort.signal.aborted) this.message = (error as Error).message;
    } finally {
      if (this.phase === 'checking') {
        this.phase = 'idle';
        if (this.preferences.settings.channel !== channel) this.check();
      }
    }
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

function publicBuild({ id, version, channel }: Build): ServerUpdateStatus['current'] {
  return { id, version, channel };
}
