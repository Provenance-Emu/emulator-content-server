import {
  type AccessPolicy,
  ContentClient,
  type GuestGrant,
  type Library,
  type User,
} from '@ecs/client';
import { explain, isUnauthorized } from '@ecs/web/lib/problems';

const SESSION_KEY = 'ecs.tray.session';

interface StoredSession {
  token: string;
  expiresAt: string;
}

/**
 * Accounts, guest links, and the local-network rule for the server being watched.
 *
 * The password is sent and then dropped. A guest token is held only until the
 * operator copies it, because the server will not show it again.
 */
export class AccessDesk {
  policy = $state<AccessPolicy | null>(null);
  bootstrapped = $state<boolean | null>(null);
  accounts = $state<User[]>([]);
  grants = $state<GuestGrant[]>([]);
  libraries = $state<Library[]>([]);
  session = $state<StoredSession | null>(readSession());
  failure = $state<string | null>(null);
  /** Shown once, after a guest link is created. */
  issuedGrant = $state<string | null>(null);
  working = $state(false);

  constructor(private readonly originOf: () => string) {}

  clear(): void {
    this.policy = null;
    this.bootstrapped = null;
    this.accounts = [];
    this.grants = [];
    this.libraries = [];
    this.failure = null;
    this.issuedGrant = null;
  }

  async refresh(): Promise<void> {
    const client = this.client();
    try {
      this.policy = await client.access();
      this.bootstrapped = (await client.capabilities()).bootstrapped ?? null;
      this.failure = null;
    } catch (error) {
      this.failure = explain(error);
      return;
    }
    if (this.bootstrapped !== true || (!this.policy.manages && !this.session)) return;
    try {
      await this.loadManaged(client);
    } catch (error) {
      if (!(isUnauthorized(error) && this.session)) {
        this.failure = explain(error);
        return;
      }
      this.forget();
      if (!this.policy.manages) return;
      try {
        await this.loadManaged(this.client());
      } catch (again) {
        this.failure = explain(again);
      }
    }
  }

  bootstrap(token: string, username: string, password: string): Promise<boolean> {
    return this.attempt(async (client) => {
      this.remember(await client.bootstrap(token, username, password));
    });
  }

  signIn(username: string, password: string): Promise<boolean> {
    return this.attempt(async (client) => {
      this.remember(await client.login(username, password));
    });
  }

  async signOut(): Promise<void> {
    await this.client()
      .logout()
      .catch(() => undefined);
    this.forget();
    await this.refresh();
  }

  saveAccess(mode: string, subnetsText: string): Promise<boolean> {
    const subnets = subnetsText
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return this.attempt(async (client) => {
      this.policy = await client.setAccess({ mode, subnets });
    });
  }

  addUser(username: string, password: string, libraryId: string, role: string): Promise<boolean> {
    return this.attempt(async (client) => {
      const user = await client.createUser({ username, password });
      if (libraryId) await client.assignMember(libraryId, user.id, role);
    });
  }

  changePassword(userId: string, password: string): Promise<boolean> {
    return this.attempt(async (client) => {
      await client.setPassword(userId, password);
    });
  }

  addGuest(libraryId: string, write: boolean, days: number): Promise<boolean> {
    return this.attempt(async (client) => {
      const issued = await client.createGuestGrant({
        libraryId,
        capabilities: write ? ['read', 'write'] : ['read'],
        expiresInSeconds: Math.round(days) * 24 * 60 * 60,
      });
      this.issuedGrant = issued.token;
    });
  }

  async revokeGuest(grantId: string): Promise<void> {
    await this.attempt(async (client) => {
      await client.revokeGuestGrant(grantId);
    });
  }

  private async attempt(run: (client: ContentClient) => Promise<void>): Promise<boolean> {
    this.working = true;
    this.failure = null;
    try {
      await run(this.client());
    } catch (error) {
      this.failure = explain(error);
      return false;
    } finally {
      this.working = false;
    }
    await this.refresh();
    return true;
  }

  private async loadManaged(client: ContentClient): Promise<void> {
    this.accounts = (await client.users()).items;
    this.grants = (await client.guestGrants()).items;
    this.libraries = (await client.libraries()).items;
  }

  private client(): ContentClient {
    const client = new ContentClient(this.originOf());
    if (this.session) client.setToken(this.session.token);
    return client;
  }

  private remember(session: { token: string; expiresAt: string }): void {
    this.session = { token: session.token, expiresAt: session.expiresAt };
    localStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
  }

  private forget(): void {
    this.session = null;
    localStorage.removeItem(SESSION_KEY);
  }
}

function readSession(): StoredSession | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as StoredSession;
    if (!stored.token || !(Date.parse(stored.expiresAt) > Date.now())) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return stored;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}
