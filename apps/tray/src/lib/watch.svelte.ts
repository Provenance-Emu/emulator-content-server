import type { AccessPolicy } from '@ecs/client';
import { type Capabilities, ContentClient } from '@ecs/client';
import type { ServerContext } from '../../../web/src/lib/application';
import { AccessDesk } from './access.svelte';
import type { DesktopSelection } from './application';

/** A suggested manual address only. Never evidence that this is the managed service endpoint. */
export const DEFAULT_ORIGIN = 'http://127.0.0.1:7878';
export class ServerWatch {
  context = $state<ServerContext | null>(null);
  desk = $state<AccessDesk | null>(null);
  policy = $state<AccessPolicy | null>(null);
  reachable = $state<boolean | null>(null);
  capabilities = $state<Capabilities | null>(null);
  checkedAt = $state<string | null>(null);
  private unsubscribe: () => void;
  private unsubscribeDesk?: () => void;
  private generation = 0;
  constructor(private readonly selection: DesktopSelection) {
    this.unsubscribe = selection.subscribe((context) => {
      this.generation++;
      this.unsubscribeDesk?.();
      this.desk?.dispose();
      this.context = context;
      this.desk = context ? new AccessDesk(context) : null;
      this.reachable = null;
      this.capabilities = null;
      this.checkedAt = null;
      this.policy = null;
      this.unsubscribeDesk = this.desk?.subscribe((state) => {
        this.policy = state.policy;
      });
      void this.check();
    });
  }
  get origin() {
    return this.context?.origin ?? '';
  }
  async check(): Promise<void> {
    const origin = this.origin;
    if (!origin) return;
    const run = this.generation;
    const client = new ContentClient(origin);
    try {
      await client.health();
      if (run !== this.generation) return;
      const capabilities = await client.capabilities();
      if (run !== this.generation) return;
      this.capabilities = capabilities;
      this.reachable = true;
      await this.desk?.refresh();
    } catch {
      if (run !== this.generation) return;
      this.reachable = false;
      this.capabilities = null;
    }
    if (run === this.generation) this.checkedAt = new Date().toLocaleTimeString();
  }
  watching(origin: string): void {
    this.selection.select({ origin, label: origin, profileKey: 'manual' });
  }
  dispose() {
    this.generation++;
    this.unsubscribe();
    this.unsubscribeDesk?.();
    this.desk?.dispose();
  }
  get summary(): string {
    if (!this.origin) return 'Choose a content server';
    const where = hostOf(this.origin);
    if (this.reachable === null) return `Checking ${where}`;
    if (!this.reachable) return `No answer from ${where}`;
    if (!this.policy?.applies || this.policy.mode === 'token') return `Sign-in required · ${where}`;
    if (this.policy.mode === 'subnets') return `Open to listed networks · ${where}`;
    return `Open on the local network · ${where}`;
  }
  get interfaceUrl(): string {
    return this.origin ? `${this.origin}/ui/` : '';
  }
}
export function hostOf(origin: string): string {
  try {
    const url = new URL(origin);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return origin;
  }
}
