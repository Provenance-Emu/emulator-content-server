import { type Capabilities, ContentClient } from '@ecs/client';

const ORIGIN_KEY = 'ecs.tray.origin';
export const DEFAULT_ORIGIN = 'http://127.0.0.1:7878';

/**
 * Watches one server and nothing else.
 *
 * The tray is an API client with no storage path of its own. It does not start
 * the server, read its data directory, or hold a credential, so everything here
 * comes from the two routes that need no token.
 */
export class ServerWatch {
  origin = $state(readOrigin());
  /** Null until the first check answers, which keeps the menu from lying. */
  reachable = $state<boolean | null>(null);
  capabilities = $state<Capabilities | null>(null);
  checkedAt = $state<string | null>(null);

  async check(): Promise<void> {
    const client = new ContentClient(this.origin);
    try {
      await client.health();
      this.capabilities = await client.capabilities();
      this.reachable = true;
    } catch {
      this.reachable = false;
      this.capabilities = null;
    }
    this.checkedAt = new Date().toLocaleTimeString();
  }

  async watching(origin: string): Promise<void> {
    this.origin = origin.replace(/\/+$/, '');
    localStorage.setItem(ORIGIN_KEY, this.origin);
    this.reachable = null;
    await this.check();
  }

  /** One line for the menu, which is all a menu bar has room for. */
  get summary(): string {
    const where = hostOf(this.origin);
    if (this.reachable === null) return `Checking ${where}`;
    return this.reachable ? `Serving on ${where}` : `No answer from ${where}`;
  }

  get interfaceUrl(): string {
    return `${this.origin}/ui/`;
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

function readOrigin(): string {
  return localStorage.getItem(ORIGIN_KEY) ?? DEFAULT_ORIGIN;
}
