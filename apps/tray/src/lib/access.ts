import {
  type AccessPolicy,
  type Capabilities,
  ContentClient,
  ContentError,
  type GuestGrant,
  type Library,
  type User,
} from '@ecs/client';
import { get, writable } from 'svelte/store';
import type { ServerContext } from '../../../web/src/lib/application.js';
import { explain, isUnauthorized } from '../../../web/src/lib/problems.js';
import type { StoredSession } from '../../../web/src/lib/session.js';

export interface AccessState {
  policy: AccessPolicy | null;
  bootstrapped: boolean | null;
  accounts: User[];
  grants: GuestGrant[];
  libraries: Library[];
  session: StoredSession | null;
  /** The server offers sign-in from its own computer, and someone signed out of it here. */
  localSignInPaused: boolean;
  failure: string | null;
  issuedGrant: string | null;
  working: boolean;
}
const empty = (): AccessState => ({
  policy: null,
  bootstrapped: null,
  accounts: [],
  grants: [],
  libraries: [],
  session: null,
  localSignInPaused: false,
  failure: null,
  issuedGrant: null,
  working: false,
});

/**
 * Asks the desktop shell for an owner session on this computer's own server. The shell answers
 * only for the server it has verified at `origin`, and `null` when there is nothing to offer.
 */
export type LocalSignIn = (origin: string) => Promise<StoredSession | null>;
/** A refused or failed local sign-in is not retried on every ten-second poll. */
const LOCAL_SIGN_IN_PAUSE_MS = 30_000;

/** Status controls own a fixed context. Replacement disposes their subscription and pending responses. */
export class AccessDesk {
  private readonly state = writable<AccessState>(empty());
  readonly subscribe = this.state.subscribe;
  private readonly key: string;
  private epoch = 0;
  private disposed = false;
  private unsubscribe?: () => void;
  private localTriedAt = Number.NEGATIVE_INFINITY;
  /** Signing out here is a decision; it is not undone ten seconds later. */
  private localPaused = false;
  constructor(
    private readonly context: ServerContext,
    private readonly localSignIn?: LocalSignIn,
    private readonly now: () => number = Date.now,
  ) {
    this.key = context.key;
    this.restore();
    this.unsubscribe = context.sessions.subscribe?.(() => {
      if (!this.live()) return;
      const next = context.sessions.load();
      if (next?.token === get(this.state).session?.token) return;
      this.epoch++;
      context.client.setToken(undefined);
      this.state.set({ ...empty(), session: next });
      context.client.setToken(next?.token);
      void this.refresh();
    });
  }
  private live(run = this.epoch) {
    return !this.disposed && this.context.key === this.key && run === this.epoch;
  }
  private patch(value: Partial<AccessState>) {
    this.state.update((state) => ({ ...state, ...value }));
  }
  private restore() {
    const session = this.context.sessions.load();
    this.context.client.setToken(session?.token);
    this.patch({ session });
  }
  dispose() {
    this.disposed = true;
    this.epoch++;
    this.unsubscribe?.();
    this.context.client.setToken(undefined);
    this.state.set(empty());
  }
  hideGrant() {
    this.patch({ issuedGrant: null });
  }
  private retryAt = 0;
  async refresh(status?: Capabilities, includeManaged = true): Promise<void> {
    if (Date.now() < this.retryAt) return;
    const run = this.epoch;
    if (!this.live(run)) return;
    const client = this.context.client;
    try {
      const policy = await client.access();
      if (!this.live(run)) return;
      const capabilities = status ?? (await client.capabilities());
      if (!this.live(run)) return;
      this.patch({ policy, bootstrapped: capabilities.bootstrapped ?? null, failure: null });
      if (
        capabilities.bootstrapped === true &&
        capabilities.features.localOwnerSignIn === true &&
        !get(this.state).session &&
        this.localSignIn
      ) {
        if (this.localPaused) this.patch({ localSignInPaused: true });
        else await this.signInLocally(run);
        if (!this.live(run)) return;
      }
      if (
        !includeManaged ||
        capabilities.bootstrapped !== true ||
        (!policy.manages && !get(this.state).session)
      )
        return;
      try {
        await this.loadManaged(client, run);
      } catch (error) {
        if (!this.live(run)) return;
        if (!(isUnauthorized(error) && get(this.state).session)) throw error;
        this.forget();
        if (policy.manages) await this.refresh();
      }
    } catch (error) {
      if (this.live(run)) {
        if (error instanceof ContentError && error.status === 429)
          this.retryAt = Date.now() + (error.retryAfterMs ?? 60_000);
        this.patch({ failure: explain(error) });
      }
    }
  }
  /** The person at the server's own computer is its owner; they are not asked to prove it again. */
  private async signInLocally(run: number) {
    if (!this.localSignIn || this.now() - this.localTriedAt < LOCAL_SIGN_IN_PAUSE_MS) return;
    this.localPaused = false;
    this.localTriedAt = this.now();
    const session = await this.localSignIn(this.context.origin).catch(() => null);
    if (!session || !this.live(run)) return;
    this.context.client.setToken(session.token);
    this.remember(session, run);
  }
  /** Signs back in after a sign-out on this computer. */
  async signInHere(): Promise<void> {
    if (!this.live()) return;
    this.localPaused = false;
    this.localTriedAt = Number.NEGATIVE_INFINITY;
    this.patch({ localSignInPaused: false });
    await this.refresh();
  }
  bootstrap(token: string, username: string, password: string) {
    return this.attempt(async (client, run) =>
      this.remember(await client.bootstrap(token, username, password), run),
    );
  }
  signIn(username: string, password: string) {
    return this.attempt(async (client, run) =>
      this.remember(await client.login(username, password), run),
    );
  }
  async signOut() {
    if (!this.live()) return;
    const token = get(this.state).session?.token;
    const revoke = new ContentClient(this.context.origin, token).logout().catch(() => undefined);
    this.localPaused = true;
    this.forget();
    const run = this.epoch;
    await revoke;
    if (this.live(run)) await this.refresh();
  }
  saveAccess(mode: string, subnetsText: string) {
    const subnets = subnetsText.split(/[\s,]+/).filter(Boolean);
    return this.attempt(async (client) => {
      await client.setAccess({ mode, subnets });
    });
  }
  addUser(username: string, password: string, libraryId: string, role: string) {
    return this.attempt(async (client, run) => {
      const user = await client.createUser({ username, password });
      if (this.live(run) && libraryId) await client.assignMember(libraryId, user.id, role);
    });
  }
  changePassword(userId: string, password: string) {
    return this.attempt(async (client) => {
      await client.setPassword(userId, password);
    });
  }
  addGuest(libraryId: string, write: boolean, days: number) {
    return this.attempt(async (client, run) => {
      const issued = await client.createGuestGrant({
        libraryId,
        capabilities: write ? ['read', 'write'] : ['read'],
        expiresInSeconds: Math.round(days) * 86400,
      });
      if (this.live(run)) this.patch({ issuedGrant: issued.token });
    });
  }
  async revokeGuest(grantId: string) {
    await this.attempt(async (client) => {
      await client.revokeGuestGrant(grantId);
    });
  }
  private async attempt(
    runAction: (client: ContentClient, run: number) => Promise<void>,
  ): Promise<boolean> {
    const run = this.epoch;
    if (!this.live(run) || get(this.state).working) return false;
    this.patch({ working: true, failure: null });
    try {
      await runAction(this.context.client, run);
      if (!this.live(run)) {
        this.context.client.setToken(this.live() ? get(this.state).session?.token : undefined);
        return false;
      }
    } catch (error) {
      if (this.live(run)) this.patch({ failure: explain(error) });
      return false;
    } finally {
      if (this.live(run)) this.patch({ working: false });
    }
    await this.refresh();
    return this.live(run);
  }
  private async loadManaged(client: ContentClient, run: number) {
    const accounts = (await client.users()).items;
    if (!this.live(run)) return;
    const grants = (await client.guestGrants()).items.filter((grant) => !grant.revokedAt);
    if (!this.live(run)) return;
    const libraries = (await client.libraries()).items;
    if (this.live(run)) this.patch({ accounts, grants, libraries });
  }
  private remember(session: StoredSession, run: number) {
    if (!this.live(run)) return;
    this.patch({ session: { token: session.token, expiresAt: session.expiresAt } });
    this.context.sessions.save(session);
  }
  private forget() {
    this.epoch++;
    this.context.client.setToken(undefined);
    this.state.set(empty());
    this.context.sessions.clear();
  }
}
