import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  type Actor,
  type AssetKind,
  type AssetRecord,
  type ContentRootRecord,
  DomainError,
  type GuestCapability,
  type ItemPermission,
  type ItemRecord,
  isSaveAssetKind,
  type LibraryRecord,
  type LibraryRole,
  type SourceAvailability,
  type SourceFileRecord,
} from '@ecs/domain';
import {
  type BrowsePosition,
  type BrowseRecord,
  type BrowseSelection,
  browseKeys,
  type ContentRootSummaryRecord,
  type RootSummaryFilter,
} from './library-browse.js';
import { pendingMigrations } from './schema.js';

export interface CatalogLimits {
  maxUploadBytes: number;
  maxLibraryBytes: number;
  sessionTtlMs: number;
}

export interface ChangeRecord {
  cursor: number;
  entityType: string;
  entityId: string;
  op: 'upsert' | 'delete';
  libraryId: string | null;
  itemId: string | null;
  sensitive: boolean;
  recordedAt: string;
}

export interface StorageLocationRecord {
  id: string;
  label: string;
  path: string;
  createdAt: string;
}

export interface WebDavCredentialRecord {
  id: string;
  name: string;
  username: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface UploadRecord {
  id: string;
  userId: string | null;
  guestGrantId: string | null;
  libraryId: string | null;
  received: number;
  state: string;
  assetId: string | null;
}

interface UserSecret {
  id: string;
  username: string;
  passwordHash: string;
  isOwner: boolean;
}

const DEFAULT_LIMITS: CatalogLimits = {
  maxUploadBytes: 32 * 1024 * 1024 * 1024,
  maxLibraryBytes: 512 * 1024 * 1024 * 1024,
  sessionTtlMs: 12 * 60 * 60 * 1000,
};

function nowIso(): string {
  return new Date().toISOString();
}

function assertLocationLabel(label: string): void {
  if (label.trim() !== label || label.length < 1 || label.length > 80 || /[\\/]/.test(label)) {
    throw new DomainError('invalid-location', 400, 'A location label must be 1-80 characters');
  }
}

function mapStorageLocation(row: StorageLocationRow): StorageLocationRecord {
  return { id: row.id, label: row.label, path: row.path, createdAt: row.created_at };
}

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export class CatalogDatabase {
  readonly limits: CatalogLimits;
  private readonly db: DatabaseSync;

  constructor(filename: string, limits: Partial<CatalogLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = FULL');
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.function('ecs_browse_fold', { deterministic: true }, (value) =>
        String(value ?? '')
          .normalize('NFC')
          .toLowerCase(),
      );
      this.migrate();
      this.db
        .prepare(
          "UPDATE content_roots SET scan_state = 'failed', last_scan_completed_at = ?, scan_error = 'Scan interrupted. Retry scan.' WHERE scan_state = 'pending'",
        )
        .run(nowIso());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  integrity(): string {
    const row = this.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    return row.integrity_check;
  }

  backupTo(destination: string): void {
    this.db.exec('PRAGMA wal_checkpoint(FULL)');
    this.db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
  }

  blobHashes(): string[] {
    return this.blobPlacements().map((blob) => blob.sha256);
  }

  blobPlacements(): { sha256: string; locationId: string | null }[] {
    const rows = this.db.prepare('SELECT sha256, location_id FROM blobs').all() as Array<{
      sha256: string;
      location_id: string | null;
    }>;
    return rows.map((row) => ({ sha256: row.sha256, locationId: row.location_id }));
  }

  blobRecord(sha256: string): { sha256: string; locationId: string | null } | null {
    const row = this.one<{ sha256: string; location_id: string | null }>(
      'SELECT sha256, location_id FROM blobs WHERE sha256 = ?',
      sha256,
    );
    if (!row) return null;
    return { sha256: row.sha256, locationId: row.location_id };
  }

  ensureServer(displayName: string): {
    serverId: string;
    displayName: string;
    bootstrapped: boolean;
  } {
    const existing = this.one<{
      server_id: string;
      display_name: string;
      bootstrapped_at: string | null;
    }>('SELECT server_id, display_name, bootstrapped_at FROM server_state WHERE id = 1');
    if (existing) {
      return {
        serverId: existing.server_id,
        displayName: existing.display_name,
        bootstrapped: existing.bootstrapped_at !== null,
      };
    }
    const createdAt = nowIso();
    this.db
      .prepare(
        'INSERT INTO server_state (id, server_id, display_name, bootstrapped_at, created_at) VALUES (1, ?, ?, NULL, ?)',
      )
      .run(randomUUID(), displayName, createdAt);
    return this.serverRow();
  }

  server(): { serverId: string; displayName: string; bootstrapped: boolean } {
    return this.serverRow();
  }

  accessPolicy(): { mode: 'lan' | 'token' | 'subnets'; subnets: string[] } {
    const row = this.one<{ access_mode: string; access_subnets: string }>(
      'SELECT access_mode, access_subnets FROM server_state WHERE id = 1',
    );
    if (!row) throw new DomainError('uninitialized', 500, 'Server state is missing');
    const mode =
      row.access_mode === 'token' || row.access_mode === 'subnets' ? row.access_mode : 'lan';
    let subnets: string[] = [];
    try {
      const parsed = JSON.parse(row.access_subnets) as unknown;
      if (Array.isArray(parsed)) {
        subnets = parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      subnets = [];
    }
    return { mode, subnets };
  }

  setAccessPolicy(input: {
    mode: 'lan' | 'token' | 'subnets';
    subnets: string[];
    actorId: string;
  }): void {
    if (input.mode !== 'lan' && input.mode !== 'token' && input.mode !== 'subnets') {
      throw new DomainError('invalid-body', 400, 'Access mode must be lan, token, or subnets');
    }
    this.db
      .prepare('UPDATE server_state SET access_mode = ?, access_subnets = ? WHERE id = 1')
      .run(input.mode, JSON.stringify(input.subnets));
    this.insertAudit(input.actorId, 'set-access', 'server', null, {
      mode: input.mode,
      subnets: input.subnets.join(' '),
    });
  }

  /**
   * The account a trusted socket acts as. `owner` is this machine. `member` can
   * read and write the library and cannot change accounts or the access rule.
   */
  localActor(level: 'owner' | 'member'): Actor | null {
    const owner = this.one<{ id: string; username: string }>(
      'SELECT id, username FROM users WHERE is_owner = 1 LIMIT 1',
    );
    if (!owner) return null;
    if (level === 'owner') {
      return {
        kind: 'user',
        userId: owner.id,
        username: owner.username,
        isOwner: true,
        tokenKind: 'session',
        deviceId: null,
        scopes: ['read', 'write', 'admin'],
      };
    }
    return {
      kind: 'user',
      userId: owner.id,
      username: owner.username,
      isOwner: false,
      tokenKind: 'session',
      deviceId: null,
      scopes: ['read', 'write'],
      localTrust: true,
    };
  }

  listUsers(): Array<{ id: string; username: string; isOwner: boolean; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT id, username, is_owner, created_at FROM users ORDER BY created_at')
      .all() as Array<{ id: string; username: string; is_owner: number; created_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      isOwner: row.is_owner === 1,
      createdAt: row.created_at,
    }));
  }

  /**
   * Replaces a password and ends that account's other sessions. The hash is the
   * only form stored, and the audit row records that a password changed.
   */
  setPassword(
    userId: string,
    passwordHash: string,
    actorId: string,
    keepTokenHash: string | null,
  ): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(passwordHash, userId);
      if (result.changes === 0) return false;
      this.db
        .prepare(
          `UPDATE sessions SET revoked_at = ?
           WHERE user_id = ? AND revoked_at IS NULL AND token_hash != COALESCE(?, '')`,
        )
        .run(nowIso(), userId, keepTokenHash);
      this.db
        .prepare(
          'UPDATE webdav_credentials SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
        )
        .run(nowIso(), userId);
      this.insertAudit(actorId, 'set-password', 'user', userId, {});
      return true;
    });
  }

  saveBootstrapHash(hash: string): void {
    this.db.exec('DELETE FROM bootstrap_tokens');
    this.db
      .prepare('INSERT INTO bootstrap_tokens (token_hash, created_at) VALUES (?, ?)')
      .run(hash, nowIso());
  }

  hasBootstrapToken(): boolean {
    return (
      this.one<{ token_hash: string }>('SELECT token_hash FROM bootstrap_tokens') !== undefined
    );
  }

  bootstrap(input: {
    bootstrapTokenHash: string;
    username: string;
    passwordHash: string;
    sessionHash: string;
    libraryName: string;
  }): { userId: string; libraryId: string; expiresAt: string } {
    return this.transaction(() => {
      const token = this.one<{ token_hash: string }>(
        'SELECT token_hash FROM bootstrap_tokens WHERE token_hash = ?',
        input.bootstrapTokenHash,
      );
      if (!token) throw new DomainError('invalid-bootstrap', 401, 'Bootstrap token is invalid');
      if (this.one('SELECT id FROM users')) {
        throw new DomainError('already-bootstrapped', 409, 'This server already has an owner');
      }
      const createdAt = nowIso();
      const userId = randomUUID();
      const libraryId = randomUUID();
      this.db
        .prepare(
          'INSERT INTO users (id, username, password_hash, is_owner, created_at) VALUES (?, ?, ?, 1, ?)',
        )
        .run(userId, input.username, input.passwordHash, createdAt);
      this.db
        .prepare(
          'INSERT INTO libraries (id, name, owner_id, revision, created_at) VALUES (?, ?, ?, 1, ?)',
        )
        .run(libraryId, input.libraryName, userId, createdAt);
      this.db
        .prepare(
          'INSERT INTO memberships (library_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(libraryId, userId, 'owner', createdAt);
      this.db.prepare('DELETE FROM bootstrap_tokens').run();
      this.db.prepare('UPDATE server_state SET bootstrapped_at = ? WHERE id = 1').run(createdAt);
      const expiresAt = this.insertSession(userId, input.sessionHash, createdAt);
      this.insertAudit(userId, 'bootstrap', 'user', userId, {});
      this.insertChange('library', libraryId, 'upsert', libraryId, null, false, createdAt, null);
      return { userId, libraryId, expiresAt };
    });
  }

  findUser(username: string): UserSecret | null {
    const row = this.one<{
      id: string;
      username: string;
      password_hash: string;
      is_owner: number;
    }>('SELECT id, username, password_hash, is_owner FROM users WHERE username = ?', username);
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      isOwner: row.is_owner === 1,
    };
  }

  recordAuthFailure(username: string): void {
    this.insertAudit(null, 'login-failed', 'user', null, { username });
  }

  createSession(userId: string, sessionHash: string): { expiresAt: string } {
    const expiresAt = this.insertSession(userId, sessionHash, nowIso());
    this.insertAudit(userId, 'login', 'session', userId, {});
    return { expiresAt };
  }

  revokeToken(tokenHash: string, actorId: string | null): boolean {
    const session = this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(nowIso(), tokenHash);
    const device = this.db
      .prepare(
        'UPDATE device_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
      )
      .run(nowIso(), tokenHash);
    const guest = this.db
      .prepare('UPDATE guest_grants SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(nowIso(), tokenHash);
    const revoked = Number(session.changes) + Number(device.changes) + Number(guest.changes) > 0;
    if (revoked) this.insertAudit(actorId, 'revoke-token', 'token', null, {});
    return revoked;
  }

  authenticate(tokenHash: string): Actor | null {
    const now = nowIso();
    const session = this.one<{
      user_id: string;
      username: string;
      is_owner: number;
      expires_at: string;
    }>(
      `SELECT s.user_id, u.username, u.is_owner, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
      tokenHash,
    );
    if (session) {
      if (session.expires_at <= now) return null;
      return {
        kind: 'user',
        userId: session.user_id,
        username: session.username,
        isOwner: session.is_owner === 1,
        tokenKind: 'session',
        deviceId: null,
        scopes: ['read', 'write', 'admin'],
      };
    }
    const device = this.one<{
      id: string;
      user_id: string;
      username: string;
      is_owner: number;
      scopes_json: string;
      expires_at: string | null;
    }>(
      `SELECT d.id, d.user_id, u.username, u.is_owner, d.scopes_json, d.expires_at
       FROM device_tokens d JOIN users u ON u.id = d.user_id
       WHERE d.token_hash = ? AND d.revoked_at IS NULL`,
      tokenHash,
    );
    if (device) {
      if (device.expires_at && device.expires_at <= now) return null;
      this.db.prepare('UPDATE device_tokens SET last_used_at = ? WHERE id = ?').run(now, device.id);
      return {
        kind: 'user',
        userId: device.user_id,
        username: device.username,
        isOwner: device.is_owner === 1,
        tokenKind: 'device',
        deviceId: device.id,
        scopes: parsePermissions(device.scopes_json),
      };
    }
    const guest = this.one<{
      id: string;
      library_id: string;
      item_id: string | null;
      capabilities_json: string;
      expires_at: string;
    }>(
      `SELECT id, library_id, item_id, capabilities_json, expires_at
       FROM guest_grants WHERE token_hash = ? AND revoked_at IS NULL`,
      tokenHash,
    );
    if (!guest || guest.expires_at <= now) return null;
    return {
      kind: 'guest',
      grantId: guest.id,
      libraryId: guest.library_id,
      itemId: guest.item_id,
      capabilities: parseCapabilities(guest.capabilities_json),
    };
  }

  createUser(input: { username: string; passwordHash: string; actorId: string }): {
    id: string;
    username: string;
    isOwner: boolean;
    createdAt: string;
  } {
    const createdAt = nowIso();
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO users (id, username, password_hash, is_owner, created_at) VALUES (?, ?, ?, 0, ?)',
      )
      .run(id, input.username, input.passwordHash, createdAt);
    this.insertAudit(input.actorId, 'create-user', 'user', id, { username: input.username });
    return { id, username: input.username, isOwner: false, createdAt };
  }

  createLibrary(ownerId: string, name: string, deviceId: string | null = null): LibraryRecord {
    const createdAt = nowIso();
    const id = randomUUID();
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO libraries (id, name, owner_id, revision, created_at) VALUES (?, ?, ?, 1, ?)',
        )
        .run(id, name, ownerId, createdAt);
      this.db
        .prepare(
          'INSERT INTO memberships (library_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(id, ownerId, 'owner', createdAt);
      this.insertChange('library', id, 'upsert', id, null, false, createdAt, deviceId);
      this.insertAudit(ownerId, 'create-library', 'library', id, { name });
    });
    return { id, name, ownerId, revision: 1, createdAt };
  }

  browseLibrary(input: BrowseSelection): { items: BrowseRecord[]; next: BrowsePosition | null } {
    return this.transaction(() => {
      const keys = browseKeys(this.db, input);
      const more = keys.length > input.limit;
      const selected = keys.slice(0, input.limit);
      const items: BrowseRecord[] = selected.map((key) => {
        if (key.entity_type === 'item') {
          const item = this.getItem(key.id);
          if (!item) throw new DomainError('not-found', 404, 'Item not found');
          return {
            entityType: 'item',
            item,
            previewAsset: key.preview_id ? this.getAsset(key.preview_id) : null,
          };
        }
        if (key.entity_type === 'source') {
          const source = this.getSource(key.id);
          if (!source) throw new DomainError('not-found', 404, 'Source not found');
          return { entityType: 'source', source };
        }
        const asset = this.getAsset(key.id);
        if (!asset) throw new DomainError('not-found', 404, 'Asset not found');
        const item = this.getItem(asset.itemId);
        if (!item) throw new DomainError('not-found', 404, 'Item not found');
        return { entityType: 'asset', asset, item };
      });
      const last = selected.at(-1);
      return { items, next: more && last ? { entityType: last.entity_type, id: last.id } : null };
    });
  }

  listContentRootSummaries(filter: RootSummaryFilter): ContentRootSummaryRecord[] {
    // These are management summaries containing server paths, never public browse DTOs.
    if (
      filter.actor.kind !== 'user' ||
      !filter.actor.isOwner ||
      !filter.actor.scopes.includes('read')
    )
      return [];
    const where =
      filter.libraryId === undefined
        ? ''
        : filter.libraryId === null
          ? 'AND r.library_id IS NULL'
          : 'AND r.library_id = ?';
    const rows = this.db
      .prepare(`SELECT r.*, (SELECT COUNT(*) FROM source_files s WHERE s.root_id = r.id) AS indexed_file_count
      FROM content_roots r WHERE (r.library_id IS NULL OR EXISTS (SELECT 1 FROM libraries l WHERE l.id = r.library_id AND l.deleted_at IS NULL)) ${where}
      ORDER BY r.created_at, r.id`)
      .all(...(typeof filter.libraryId === 'string' ? [filter.libraryId] : [])) as Array<
      ContentRootRow & {
        indexed_file_count: number;
        last_checked_at: string | null;
        availability: ContentRootSummaryRecord['availability'];
        medium: string | null;
        scan_state: ContentRootSummaryRecord['scanState'];
        last_scan_started_at: string | null;
        last_scan_completed_at: string | null;
        scan_error: string | null;
      }
    >;
    return rows.map((row) => ({
      ...mapContentRoot(row),
      indexedFileCount: Number(row.indexed_file_count),
      lastCheckedAt: row.last_checked_at,
      availability: row.availability,
      medium: row.medium,
      scanState: row.scan_state,
      lastScanStartedAt: row.last_scan_started_at,
      lastScanCompletedAt: row.last_scan_completed_at,
      scanError: row.scan_error,
    }));
  }

  renameLibrary(input: {
    id: string;
    name: string;
    baseRevision: number;
    actorId: string;
    deviceId: string | null;
  }): LibraryRecord {
    return this.transaction(() => {
      const current = this.getLibrary(input.id);
      if (!current) throw new DomainError('not-found', 404, 'Library not found');
      const result = this.db
        .prepare(
          'UPDATE libraries SET name = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL',
        )
        .run(input.name, input.id, input.baseRevision);
      if (result.changes === 0)
        throw new DomainError('conflict', 409, 'Library revision does not match');
      this.insertChange(
        'library',
        input.id,
        'upsert',
        input.id,
        null,
        false,
        nowIso(),
        input.deviceId,
      );
      this.insertAudit(input.actorId, 'rename-library', 'library', input.id, { name: input.name });
      return { ...current, name: input.name, revision: current.revision + 1 };
    });
  }

  assignUnassignedRoot(input: {
    rootId: string;
    libraryId: string;
    actorId: string;
    deviceId: string | null;
  }): ContentRootRecord {
    return this.transaction(() => {
      if (!this.getLibrary(input.libraryId))
        throw new DomainError('not-found', 404, 'Library not found');
      const root = this.getContentRoot(input.rootId);
      if (!root) throw new DomainError('not-found', 404, 'Content root not found');
      if (root.libraryId === input.libraryId) return root;
      if (root.libraryId !== null)
        throw new DomainError('conflict', 409, 'That folder already belongs to a library');
      this.db
        .prepare('UPDATE content_roots SET library_id = ? WHERE id = ? AND library_id IS NULL')
        .run(input.libraryId, input.rootId);
      this.insertChange(
        'content-root',
        root.id,
        'upsert',
        input.libraryId,
        null,
        false,
        nowIso(),
        input.deviceId,
      );
      this.insertAudit(input.actorId, 'assign-content-root', 'content-root', root.id, {
        libraryId: input.libraryId,
      });
      return { ...root, libraryId: input.libraryId };
    });
  }

  recordRootCheck(input: {
    rootId: string;
    availability: 'online' | 'offline';
    medium: string | null;
    checkedAt?: string;
  }): void {
    this.transaction(() => {
      const root = this.getContentRoot(input.rootId);
      if (!root) throw new DomainError('not-found', 404, 'Content root not found');
      const previous = this.one<{ availability: string; medium: string | null }>(
        'SELECT availability, medium FROM content_roots WHERE id = ?',
        input.rootId,
      );
      this.db
        .prepare(
          'UPDATE content_roots SET last_checked_at = ?, availability = ?, medium = ? WHERE id = ?',
        )
        .run(input.checkedAt ?? nowIso(), input.availability, input.medium, input.rootId);
      if (previous?.availability === input.availability && previous.medium === input.medium) return;
      this.insertChange(
        'content-root',
        root.id,
        'upsert',
        root.libraryId,
        null,
        false,
        nowIso(),
        null,
      );
    });
  }

  beginRootScan(rootId: string): void {
    this.transaction(() => {
      const root = this.getContentRoot(rootId);
      if (!root) throw new DomainError('not-found', 404, 'Content root not found');
      if (
        this.one<{ scan_state: string }>(
          'SELECT scan_state FROM content_roots WHERE id = ?',
          rootId,
        )?.scan_state === 'pending'
      )
        throw new DomainError('conflict', 409, 'A scan is already pending for that folder');
      this.db
        .prepare(
          "UPDATE content_roots SET scan_state = 'pending', last_scan_started_at = ?, last_scan_completed_at = NULL, scan_error = NULL WHERE id = ?",
        )
        .run(nowIso(), rootId);
      this.insertChange(
        'content-root',
        root.id,
        'upsert',
        root.libraryId,
        null,
        false,
        nowIso(),
        null,
      );
    });
  }

  finishRootScan(input: { rootId: string; succeeded: boolean }): void {
    this.transaction(() => {
      const root = this.getContentRoot(input.rootId);
      if (!root) throw new DomainError('not-found', 404, 'Content root not found');
      this.db
        .prepare(
          'UPDATE content_roots SET scan_state = ?, last_scan_completed_at = ?, scan_error = ? WHERE id = ?',
        )
        .run(
          input.succeeded ? 'completed' : 'failed',
          nowIso(),
          input.succeeded ? null : 'Scan failed. Retry scan.',
          input.rootId,
        );
      this.insertChange(
        'content-root',
        root.id,
        'upsert',
        root.libraryId,
        null,
        false,
        nowIso(),
        null,
      );
    });
  }

  listBrowseLibraries(actor: Actor): LibraryRecord[] {
    if (actor.kind === 'guest') {
      if (!actor.capabilities.includes('read')) return [];
      const library = this.getLibrary(actor.libraryId);
      return library ? [library] : [];
    }
    if (!actor.scopes.includes('read')) return [];
    if (actor.isOwner || actor.localTrust === true) return this.listLibraries(actor.userId, true);
    const rows = this.db
      .prepare(`SELECT l.* FROM libraries l WHERE l.deleted_at IS NULL AND (
      EXISTS (SELECT 1 FROM memberships m WHERE m.library_id = l.id AND m.user_id = ?)
      OR EXISTS (SELECT 1 FROM items i JOIN item_acl acl ON acl.item_id = i.id
        WHERE i.library_id = l.id AND i.deleted_at IS NULL AND acl.user_id = ? AND acl.permission = 'read'))
      ORDER BY l.created_at, l.id`)
      .all(actor.userId, actor.userId) as Array<{
      id: string;
      name: string;
      owner_id: string;
      revision: number;
      created_at: string;
    }>;
    return rows.map(mapLibrary);
  }

  listLibraries(userId: string, isOwner: boolean): LibraryRecord[] {
    const sql = isOwner
      ? 'SELECT id, name, owner_id, revision, created_at FROM libraries WHERE deleted_at IS NULL ORDER BY created_at'
      : `SELECT l.id, l.name, l.owner_id, l.revision, l.created_at
         FROM libraries l JOIN memberships m ON m.library_id = l.id
         WHERE m.user_id = ? AND l.deleted_at IS NULL ORDER BY l.created_at`;
    const rows = this.db.prepare(sql).all(...(isOwner ? [] : [userId])) as Array<{
      id: string;
      name: string;
      owner_id: string;
      revision: number;
      created_at: string;
    }>;
    return rows.map(mapLibrary);
  }

  getLibrary(id: string): LibraryRecord | null {
    const row = this.one<{
      id: string;
      name: string;
      owner_id: string;
      revision: number;
      created_at: string;
    }>(
      'SELECT id, name, owner_id, revision, created_at FROM libraries WHERE id = ? AND deleted_at IS NULL',
      id,
    );
    return row ? mapLibrary(row) : null;
  }

  createContentRoot(input: {
    path: string;
    label: string;
    libraryId: string | null;
    actorId: string;
  }): ContentRootRecord {
    const createdAt = nowIso();
    const id = randomUUID();
    this.transaction(() => {
      if (this.contentRootAt(input.path)) {
        throw new DomainError('conflict', 409, 'That folder is already registered');
      }
      this.db
        .prepare(
          'INSERT INTO content_roots (id, path, label, library_id, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, input.path, input.label, input.libraryId, createdAt);
      this.insertChange(
        'content-root',
        id,
        'upsert',
        input.libraryId,
        null,
        false,
        createdAt,
        null,
      );
      this.insertAudit(input.actorId, 'create-content-root', 'content-root', id, {
        path: input.path,
        label: input.label,
      });
    });
    return {
      id,
      path: input.path,
      label: input.label,
      libraryId: input.libraryId,
      createdAt,
    };
  }

  listContentRoots(): ContentRootRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, path, label, library_id, created_at FROM content_roots ORDER BY created_at',
      )
      .all() as ContentRootRow[];
    return rows.map(mapContentRoot);
  }

  getContentRoot(id: string): ContentRootRecord | null {
    const row = this.one<ContentRootRow>(
      'SELECT id, path, label, library_id, created_at FROM content_roots WHERE id = ?',
      id,
    );
    return row ? mapContentRoot(row) : null;
  }

  deleteContentRoot(id: string, actorId: string): void {
    this.transaction(() => {
      const existing = this.getContentRoot(id);
      if (!existing) throw new DomainError('not-found', 404, 'Content root not found');
      this.db.prepare('DELETE FROM content_roots WHERE id = ?').run(id);
      this.insertChange(
        'content-root',
        id,
        'delete',
        existing.libraryId,
        null,
        false,
        nowIso(),
        null,
      );
      this.insertAudit(actorId, 'delete-content-root', 'content-root', id, {
        path: existing.path,
      });
    });
  }

  createStorageLocation(input: {
    path: string;
    label: string;
    actorId: string;
  }): StorageLocationRecord {
    assertLocationLabel(input.label);
    const createdAt = nowIso();
    const id = randomUUID();
    this.transaction(() => {
      if (this.storageLocationAt(input.path)) {
        throw new DomainError('conflict', 409, 'That folder is already registered');
      }
      if (this.one('SELECT id FROM storage_locations WHERE label = ?', input.label)) {
        throw new DomainError('conflict', 409, 'That label is already used');
      }
      this.db
        .prepare('INSERT INTO storage_locations (id, label, path, created_at) VALUES (?, ?, ?, ?)')
        .run(id, input.label, input.path, createdAt);
      this.insertAudit(input.actorId, 'create-storage-location', 'storage-location', id, {
        path: input.path,
        label: input.label,
      });
    });
    return { id, path: input.path, label: input.label, createdAt };
  }

  listStorageLocations(): StorageLocationRecord[] {
    const rows = this.db
      .prepare('SELECT id, label, path, created_at FROM storage_locations ORDER BY created_at')
      .all() as StorageLocationRow[];
    return rows.map(mapStorageLocation);
  }

  getStorageLocation(id: string): StorageLocationRecord | null {
    const row = this.one<StorageLocationRow>(
      'SELECT id, label, path, created_at FROM storage_locations WHERE id = ?',
      id,
    );
    return row ? mapStorageLocation(row) : null;
  }

  /**
   * Where new bytes are written. Null means the data directory, which is always
   * present and is not itself a location row.
   */
  writeLocation(): StorageLocationRecord | null {
    const row = this.one<{ write_location_id: string | null }>(
      'SELECT write_location_id FROM server_state WHERE id = 1',
    );
    if (!row?.write_location_id) return null;
    return this.getStorageLocation(row.write_location_id);
  }

  setWriteLocation(locationId: string | null, actorId: string): void {
    this.transaction(() => {
      if (locationId !== null && !this.getStorageLocation(locationId)) {
        throw new DomainError('not-found', 404, 'Storage location not found');
      }
      const result = this.db
        .prepare('UPDATE server_state SET write_location_id = ? WHERE id = 1')
        .run(locationId);
      if (result.changes === 0) {
        throw new DomainError('uninitialized', 500, 'Server state is missing');
      }
      this.insertAudit(actorId, 'set-write-location', 'storage-location', locationId, {});
    });
  }

  deleteStorageLocation(id: string, actorId: string): void {
    this.transaction(() => {
      const existing = this.getStorageLocation(id);
      if (!existing) throw new DomainError('not-found', 404, 'Storage location not found');
      if (this.writeLocation()?.id === id) {
        throw new DomainError('conflict', 409, 'That location is where new bytes are written');
      }
      const referenced = this.one<{ n: number }>(
        'SELECT COUNT(*) AS n FROM blobs WHERE location_id = ?',
        id,
      );
      if (Number(referenced?.n ?? 0) > 0) {
        throw new DomainError('conflict', 409, 'That location still holds blobs');
      }
      this.db.prepare('DELETE FROM storage_locations WHERE id = ?').run(id);
      this.insertAudit(actorId, 'delete-storage-location', 'storage-location', id, {
        path: existing.path,
      });
    });
  }

  private storageLocationAt(path: string): StorageLocationRecord | null {
    const row = this.one<StorageLocationRow>(
      'SELECT id, label, path, created_at FROM storage_locations WHERE path = ?',
      path,
    );
    return row ? mapStorageLocation(row) : null;
  }

  /**
   * Replaces the names found in one folder. An offline volume keeps the rows
   * and marks them offline. Paths stay in this table; callers do not return them.
   */
  applyInspection(input: {
    rootId: string;
    actorId: string;
    online: boolean;
    files: Array<{
      relativePath: string;
      displayName: string;
      size: number;
      blocks: number;
      kind: string;
      systemId: string | null;
      availability: SourceAvailability;
    }>;
  }): number {
    const root = this.getContentRoot(input.rootId);
    if (!root) throw new DomainError('not-found', 404, 'Content root not found');
    if (!input.online) {
      this.markRootOffline(input.rootId);
      return this.listSources(input.rootId).length;
    }
    const scannedAt = nowIso();
    this.transaction(() => {
      const existing = this.sourceRows(input.rootId);
      const byPath = new Map(existing.map((row) => [row.relative_path, row]));
      const seen = new Set<string>();
      for (const file of input.files) {
        assertSourcePath(file.relativePath);
        assertSourceKind(file.kind);
        seen.add(file.relativePath);
        const prior = byPath.get(file.relativePath);
        if (!prior) {
          const id = randomUUID();
          this.db
            .prepare(
              `INSERT INTO source_files (
                id, root_id, relative_path, display_name, size, blocks, kind, system_id,
                availability, scanned_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              input.rootId,
              file.relativePath,
              file.displayName,
              file.size,
              file.blocks,
              file.kind,
              file.systemId,
              file.availability,
              scannedAt,
            );
          this.insertChange(
            'source',
            id,
            'upsert',
            root.libraryId,
            null,
            sensitiveKind(file.kind),
            scannedAt,
            null,
          );
          continue;
        }
        const changed =
          prior.display_name !== file.displayName ||
          prior.size !== file.size ||
          prior.blocks !== file.blocks ||
          prior.kind !== file.kind ||
          prior.system_id !== file.systemId ||
          prior.availability !== file.availability;
        if (!changed) continue;
        this.db
          .prepare(
            `UPDATE source_files
             SET display_name = ?, size = ?, blocks = ?, kind = ?, system_id = ?,
                 availability = ?, scanned_at = ?
             WHERE id = ?`,
          )
          .run(
            file.displayName,
            file.size,
            file.blocks,
            file.kind,
            file.systemId,
            file.availability,
            scannedAt,
            prior.id,
          );
        this.insertChange(
          'source',
          prior.id,
          'upsert',
          root.libraryId,
          null,
          sensitiveKind(file.kind),
          scannedAt,
          null,
        );
      }
      for (const prior of existing) {
        if (seen.has(prior.relative_path)) continue;
        this.db.prepare('DELETE FROM source_files WHERE id = ?').run(prior.id);
        this.insertChange(
          'source',
          prior.id,
          'delete',
          root.libraryId,
          null,
          sensitiveKind(prior.kind),
          scannedAt,
          null,
        );
      }
      this.insertAudit(input.actorId, 'scan-content-root', 'content-root', input.rootId, {
        count: String(input.files.length),
      });
    });
    return input.files.length;
  }

  listSources(rootId: string, limit?: number): SourceFileRecord[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new Error('Invalid source row limit');
    return this.sourceRows(rootId, limit).map((row) => mapSource(row));
  }

  getSource(id: string): SourceFileRecord | null {
    const row = this.one<SourceRow>(
      `SELECT s.*, r.library_id
       FROM source_files s JOIN content_roots r ON r.id = s.root_id
       WHERE s.id = ?`,
      id,
    );
    return row ? mapSource(row) : null;
  }

  markRootOffline(rootId: string): void {
    const root = this.getContentRoot(rootId);
    if (!root) throw new DomainError('not-found', 404, 'Content root not found');
    const rows = this.sourceRows(rootId).filter((row) => row.availability !== 'offline');
    if (rows.length === 0) return;
    const scannedAt = nowIso();
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE source_files SET availability = 'offline', scanned_at = ?
           WHERE root_id = ? AND availability != 'offline'`,
        )
        .run(scannedAt, rootId);
      for (const row of rows) {
        this.insertChange(
          'source',
          row.id,
          'upsert',
          root.libraryId,
          null,
          sensitiveKind(row.kind),
          scannedAt,
          null,
        );
      }
    });
  }

  updateSourcePresence(
    id: string,
    presence: { availability: SourceAvailability; size: number; blocks: number },
  ): void {
    const current = this.getSource(id);
    if (!current) throw new DomainError('not-found', 404, 'Source file not found');
    if (
      current.availability === presence.availability &&
      current.size === presence.size &&
      current.blocks === presence.blocks
    ) {
      return;
    }
    const scannedAt = nowIso();
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE source_files
           SET availability = ?, size = ?, blocks = ?, scanned_at = ?
           WHERE id = ?`,
        )
        .run(presence.availability, presence.size, presence.blocks, scannedAt, id);
      const root = this.getContentRoot(current.rootId);
      this.insertChange(
        'source',
        id,
        'upsert',
        root?.libraryId ?? current.libraryId,
        null,
        sensitiveKind(current.kind),
        scannedAt,
        null,
      );
    });
  }

  private sourceRows(rootId: string, limit?: number): SourceRow[] {
    return this.db
      .prepare(
        `SELECT s.*, r.library_id
         FROM source_files s JOIN content_roots r ON r.id = s.root_id
         WHERE s.root_id = ?
         ORDER BY s.relative_path LIMIT ?`,
      )
      .all(rootId, limit ?? -1) as SourceRow[];
  }

  private contentRootAt(path: string): ContentRootRecord | null {
    const row = this.one<ContentRootRow>(
      'SELECT id, path, label, library_id, created_at FROM content_roots WHERE path = ?',
      path,
    );
    return row ? mapContentRoot(row) : null;
  }

  setMember(libraryId: string, userId: string, role: LibraryRole, actorId: string): void {
    const createdAt = nowIso();
    this.db
      .prepare('DELETE FROM memberships WHERE library_id = ? AND user_id = ?')
      .run(libraryId, userId);
    this.db
      .prepare(
        'INSERT INTO memberships (library_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(libraryId, userId, role, createdAt);
    this.insertAudit(actorId, 'set-member', 'membership', userId, { libraryId, role });
  }

  removeMember(libraryId: string, userId: string, actorId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM memberships WHERE library_id = ? AND user_id = ?')
      .run(libraryId, userId);
    if (result.changes === 0) return false;
    this.insertAudit(actorId, 'remove-member', 'membership', userId, { libraryId });
    return true;
  }

  membership(userId: string, libraryId: string): LibraryRole | null {
    const row = this.one<{ role: LibraryRole }>(
      'SELECT role FROM memberships WHERE user_id = ? AND library_id = ?',
      userId,
      libraryId,
    );
    return row?.role ?? null;
  }

  itemPermissions(userId: string, itemId: string): ItemPermission[] {
    const rows = this.db
      .prepare('SELECT permission FROM item_acl WHERE user_id = ? AND item_id = ?')
      .all(userId, itemId) as Array<{ permission: ItemPermission }>;
    return rows.map((row) => row.permission);
  }

  setItemPermission(
    itemId: string,
    userId: string,
    permission: ItemPermission,
    actorId: string,
  ): void {
    this.db.prepare('DELETE FROM item_acl WHERE item_id = ? AND user_id = ?').run(itemId, userId);
    this.db
      .prepare(
        'INSERT INTO item_acl (item_id, user_id, permission, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(itemId, userId, permission, nowIso());
    this.insertAudit(actorId, 'set-item-access', 'item', itemId, { userId, permission });
  }

  removeItemPermission(itemId: string, userId: string, actorId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM item_acl WHERE item_id = ? AND user_id = ?')
      .run(itemId, userId);
    if (result.changes === 0) return false;
    this.insertAudit(actorId, 'remove-item-access', 'item', itemId, { userId });
    return true;
  }

  createItem(input: {
    libraryId: string;
    systemIdentifier: string;
    title: string;
    md5: string | null;
    crc: string | null;
    actorId: string;
    deviceId?: string | null;
  }): ItemRecord {
    const timestamp = nowIso();
    const id = randomUUID();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO items (
            id, library_id, system_identifier, title, md5, crc, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.libraryId,
          input.systemIdentifier,
          input.title,
          input.md5,
          input.crc,
          timestamp,
          timestamp,
        );
      this.insertChange(
        'item',
        id,
        'upsert',
        input.libraryId,
        id,
        false,
        timestamp,
        input.deviceId ?? null,
      );
      this.insertAudit(input.actorId, 'create-item', 'item', id, { title: input.title });
    });
    return {
      id,
      libraryId: input.libraryId,
      systemIdentifier: input.systemIdentifier,
      title: input.title,
      md5: input.md5,
      crc: input.crc,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  getItem(id: string): ItemRecord | null {
    const row = this.itemRow(id);
    return row ? mapItem(row) : null;
  }

  updateItem(input: {
    id: string;
    baseRevision: number;
    deviceId?: string | null;
    title?: string;
    md5?: string | null;
    crc?: string | null;
    actorId: string;
  }): ItemRecord {
    return this.transaction(() => {
      const current = this.itemRow(input.id);
      if (!current || current.deleted_at) throw new DomainError('not-found', 404, 'Item not found');
      const title = input.title ?? current.title;
      const md5 = input.md5 === undefined ? current.md5 : input.md5;
      const crc = input.crc === undefined ? current.crc : input.crc;
      const timestamp = nowIso();
      const result = this.db
        .prepare(
          `UPDATE items SET title = ?, md5 = ?, crc = ?, revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        )
        .run(title, md5, crc, timestamp, input.id, input.baseRevision);
      if (result.changes === 0) {
        throw new DomainError('conflict', 409, 'Item revision does not match');
      }
      this.insertChange(
        'item',
        input.id,
        'upsert',
        current.library_id,
        input.id,
        false,
        timestamp,
        input.deviceId ?? null,
      );
      this.insertAudit(input.actorId, 'update-item', 'item', input.id, {});
      const updated = this.itemRow(input.id);
      if (!updated) throw new DomainError('not-found', 404, 'Item not found');
      return mapItem(updated);
    });
  }

  deleteItem(id: string, actorId: string, deviceId: string | null = null): boolean {
    return this.transaction(() => {
      const current = this.itemRow(id);
      if (!current || current.deleted_at) return false;
      const timestamp = nowIso();
      this.db
        .prepare(
          'UPDATE items SET deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        )
        .run(timestamp, timestamp, id);
      this.db
        .prepare(
          'UPDATE assets SET deleted_at = ?, updated_at = ? WHERE item_id = ? AND deleted_at IS NULL',
        )
        .run(timestamp, timestamp, id);
      this.insertChange('item', id, 'delete', current.library_id, id, false, timestamp, deviceId);
      this.insertAudit(actorId, 'delete-item', 'item', id, {});
      return true;
    });
  }

  listItems(input: {
    libraryId: string;
    afterId: string | null;
    limit: number;
    itemId: string | null;
    readableByUserId?: string;
  }): { items: ItemRecord[]; nextCursor: string | null } {
    const params: SQLInputValue[] = [input.libraryId];
    let sql = 'SELECT * FROM items WHERE library_id = ? AND deleted_at IS NULL';
    if (input.readableByUserId) {
      sql += ` AND EXISTS (SELECT 1 FROM item_acl a
        WHERE a.item_id = items.id AND a.user_id = ? AND a.permission = 'read')`;
      params.push(input.readableByUserId);
    }
    if (input.itemId) {
      sql += ' AND id = ?';
      params.push(input.itemId);
    }
    if (input.afterId) {
      sql += ' AND id > ?';
      params.push(input.afterId);
    }
    sql += ' ORDER BY id LIMIT ?';
    params.push(input.limit);
    const rows = this.db.prepare(sql).all(...params) as unknown as ItemRow[];
    const items = rows.map(mapItem);
    const last = items.at(-1);
    return { items, nextCursor: items.length === input.limit && last ? last.id : null };
  }

  librarySize(libraryId: string): number {
    const row = this.one<{ total: number }>(
      `SELECT COALESCE(SUM(a.size), 0) AS total
       FROM assets a JOIN items i ON i.id = a.item_id
       WHERE i.library_id = ? AND a.deleted_at IS NULL AND i.deleted_at IS NULL`,
      libraryId,
    );
    return Number(row?.total ?? 0);
  }

  createUpload(input: {
    userId: string | null;
    guestGrantId: string | null;
    libraryId: string;
  }): UploadRecord {
    const timestamp = nowIso();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO uploads (
          id, user_id, guest_grant_id, library_id, received, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, 'open', ?, ?)`,
      )
      .run(id, input.userId, input.guestGrantId, input.libraryId, timestamp, timestamp);
    return {
      id,
      userId: input.userId,
      guestGrantId: input.guestGrantId,
      libraryId: input.libraryId,
      received: 0,
      state: 'open',
      assetId: null,
    };
  }

  getUpload(id: string): UploadRecord | null {
    const row = this.one<{
      id: string;
      user_id: string | null;
      guest_grant_id: string | null;
      library_id: string | null;
      received: number;
      state: string;
      asset_id: string | null;
    }>(
      'SELECT id, user_id, guest_grant_id, library_id, received, state, asset_id FROM uploads WHERE id = ?',
      id,
    );
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      guestGrantId: row.guest_grant_id,
      libraryId: row.library_id,
      received: Number(row.received),
      state: row.state,
      assetId: row.asset_id,
    };
  }

  setUploadReceived(id: string, received: number): void {
    const result = this.db
      .prepare(`UPDATE uploads SET received = ?, updated_at = ? WHERE id = ? AND state = 'open'`)
      .run(received, nowIso(), id);
    if (result.changes === 0) throw new DomainError('upload-closed', 409, 'Upload is not open');
  }

  completeUpload(input: {
    uploadId: string;
    itemId: string;
    kind: AssetKind;
    displayName: string;
    relativePath: string;
    baseRevision: number;
    sha256: string;
    size: number;
    md5: string;
    crc: string;
    shareable: boolean;
    actorId: string | null;
    deviceId?: string | null;
    locationId: string | null;
  }): AssetRecord {
    return this.transaction(() => {
      const upload = this.getUpload(input.uploadId);
      if (!upload) throw new DomainError('not-found', 404, 'Upload not found');
      if (upload.state === 'completed' && upload.assetId) {
        const existing = this.getAsset(upload.assetId);
        if (!existing) throw new DomainError('not-found', 404, 'Asset not found');
        return existing;
      }
      if (upload.state !== 'open')
        throw new DomainError('upload-closed', 409, 'Upload is not open');
      const item = this.itemRow(input.itemId);
      if (!item || item.deleted_at) throw new DomainError('not-found', 404, 'Item not found');
      if (upload.libraryId && upload.libraryId !== item.library_id) {
        throw new DomainError('conflict', 409, 'Upload belongs to another library');
      }
      if (this.librarySize(item.library_id) + input.size > this.limits.maxLibraryBytes) {
        throw new DomainError('quota-exceeded', 413, 'Library byte quota would be exceeded');
      }
      const timestamp = nowIso();
      this.db
        .prepare(
          `INSERT INTO blobs (sha256, size, md5, crc, created_at, location_id)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`,
        )
        .run(input.sha256, input.size, input.md5, input.crc, timestamp, input.locationId);
      const assetId = randomUUID();
      const placement = this.placeUpload(input, assetId, timestamp);
      this.db
        .prepare(
          `INSERT INTO assets (
            id, item_id, kind, display_name, relative_path, sha256, size, md5, crc, shareable,
            revision, created_at, updated_at, conflict_of
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .run(
          assetId,
          input.itemId,
          input.kind,
          placement.displayName,
          placement.relativePath,
          input.sha256,
          input.size,
          input.md5,
          input.crc,
          input.shareable ? 1 : 0,
          timestamp,
          timestamp,
          placement.conflictOf,
        );
      this.db
        .prepare(
          `UPDATE uploads SET state = 'completed', asset_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(assetId, timestamp, input.uploadId);
      this.insertChange(
        'asset',
        assetId,
        'upsert',
        item.library_id,
        input.itemId,
        !input.shareable,
        timestamp,
        input.deviceId ?? null,
      );
      if (placement.demoteId) {
        this.demoteLive(
          placement.demoteId,
          assetId,
          timestamp,
          item.library_id,
          input.itemId,
          input.deviceId ?? null,
        );
      }
      this.insertAudit(input.actorId, 'complete-upload', 'asset', assetId, {
        sha256: input.sha256,
      });
      const asset = this.getAsset(assetId);
      if (!asset) throw new DomainError('not-found', 404, 'Asset not found');
      return asset;
    });
  }

  /**
   * Advances the item revision and decides where this upload lands.
   *
   * A stale `baseRevision` means another device already wrote. For a ROM or a
   * BIOS that is a conflict the client must resolve by refetching. For a save it
   * is not, because refusing the write discards bytes that exist nowhere else.
   * The asset already at that path stays live and untouched, so a device
   * mid-download is unaffected, and this write lands beside it as a conflict
   * copy for a person to choose between. Neither digest is lost.
   */
  private placeUpload(
    input: {
      itemId: string;
      kind: AssetKind;
      displayName: string;
      relativePath: string;
      baseRevision: number;
    },
    assetId: string,
    timestamp: string,
  ): {
    relativePath: string;
    displayName: string;
    conflictOf: string | null;
    demoteId: string | null;
  } {
    const bumped = this.db
      .prepare(
        `UPDATE items SET revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      )
      .run(timestamp, input.itemId, input.baseRevision);
    const unchanged = { relativePath: input.relativePath, displayName: input.displayName };
    if (bumped.changes > 0) {
      // A save written at the current revision is the one the writer just
      // played. It becomes the live file, and the bytes it replaces stay
      // beside it. The demotion runs after this asset is inserted, because
      // the replaced row has to point at an id that already exists.
      const live = isSaveAssetKind(input.kind)
        ? this.liveAt(input.itemId, input.relativePath)
        : null;
      return { ...unchanged, conflictOf: null, demoteId: live?.id ?? null };
    }
    if (!isSaveAssetKind(input.kind)) {
      throw new DomainError('conflict', 409, 'Item revision does not match');
    }
    const kept = { ...unchanged, demoteId: null };
    const advanced = this.db
      .prepare(
        `UPDATE items SET revision = revision + 1, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(timestamp, input.itemId);
    if (advanced.changes === 0) throw new DomainError('not-found', 404, 'Item not found');
    const live = this.one<AssetRow>(
      `SELECT * FROM assets WHERE item_id = ? AND relative_path = ? AND deleted_at IS NULL
         ORDER BY created_at DESC`,
      input.itemId,
      input.relativePath,
    );
    if (!live) return { ...kept, conflictOf: null };
    return {
      relativePath: `${input.relativePath}.conflict-${assetId.slice(0, 8)}`,
      displayName: `${input.displayName} (conflict)`,
      conflictOf: live.id,
      demoteId: null,
    };
  }

  /**
   * Makes a conflict copy the live file at its path. The bytes that were live
   * stay, renamed beside it, so choosing never discards a save.
   */
  adoptConflict(input: {
    assetId: string;
    actorId: string | null;
    deviceId?: string | null;
  }): AssetRecord {
    return this.transaction(() => {
      const chosen = this.getAsset(input.assetId);
      if (!chosen) throw new DomainError('not-found', 404, 'File not found');
      if (!isSaveAssetKind(chosen.kind)) {
        throw new DomainError('conflict', 409, 'Only a save can be chosen');
      }
      if (!chosen.conflictOf) return chosen;
      const canonical = chosen.relativePath.replace(/\.conflict-[0-9a-f]{8}$/, '');
      const live = this.liveAt(chosen.itemId, canonical);
      const item = this.itemRow(chosen.itemId);
      if (!item) throw new DomainError('not-found', 404, 'Item not found');
      const timestamp = nowIso();
      this.db
        .prepare(
          `UPDATE items SET revision = revision + 1, updated_at = ?
             WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(timestamp, chosen.itemId);
      if (live && live.id !== chosen.id) {
        this.demoteLive(
          live.id,
          chosen.id,
          timestamp,
          item.library_id,
          chosen.itemId,
          input.deviceId ?? null,
        );
      }
      const name = chosen.displayName.endsWith(' (conflict)')
        ? chosen.displayName.slice(0, -' (conflict)'.length)
        : chosen.displayName;
      this.db
        .prepare(
          `UPDATE assets SET relative_path = ?, display_name = ?, conflict_of = NULL,
             revision = revision + 1, updated_at = ? WHERE id = ?`,
        )
        .run(canonical, name, timestamp, chosen.id);
      this.insertChange(
        'asset',
        chosen.id,
        'upsert',
        item.library_id,
        chosen.itemId,
        !chosen.shareable,
        timestamp,
        input.deviceId ?? null,
      );
      this.insertAudit(input.actorId, 'adopt-conflict', 'asset', chosen.id, {});
      const adopted = this.getAsset(chosen.id);
      if (!adopted) throw new DomainError('not-found', 404, 'File not found');
      return adopted;
    });
  }

  /** The save currently served at a path, which is the one a new write replaces. */
  private liveAt(itemId: string, relativePath: string): AssetRow | undefined {
    return this.one<AssetRow>(
      `SELECT * FROM assets
         WHERE item_id = ? AND relative_path = ? AND conflict_of IS NULL AND deleted_at IS NULL`,
      itemId,
      relativePath,
    );
  }

  /** Moves a live save aside so a chosen write can take its path. Both digests remain. */
  private demoteLive(
    liveId: string,
    successorId: string,
    timestamp: string,
    libraryId: string,
    itemId: string,
    deviceId: string | null,
  ): void {
    const live = this.one<AssetRow>(
      'SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL',
      liveId,
    );
    if (!live) return;
    const name = live.display_name.endsWith(' (conflict)')
      ? live.display_name
      : `${live.display_name} (conflict)`;
    this.db
      .prepare(
        `UPDATE assets SET relative_path = ?, display_name = ?, conflict_of = ?,
           revision = revision + 1, updated_at = ? WHERE id = ?`,
      )
      .run(
        `${live.relative_path}.conflict-${liveId.slice(0, 8)}`,
        name,
        successorId,
        timestamp,
        liveId,
      );
    this.insertChange(
      'asset',
      liveId,
      'upsert',
      libraryId,
      itemId,
      live.shareable === 0,
      timestamp,
      deviceId,
    );
  }

  abortUpload(id: string, actorId: string | null): boolean {
    const result = this.db
      .prepare(
        `UPDATE uploads SET state = 'aborted', updated_at = ? WHERE id = ? AND state = 'open'`,
      )
      .run(nowIso(), id);
    if (result.changes === 0) return false;
    this.insertAudit(actorId, 'abort-upload', 'upload', id, {});
    return true;
  }

  getAsset(id: string): AssetRecord | null {
    const row = this.one<AssetRow>('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL', id);
    return row ? mapAsset(row) : null;
  }

  deleteAsset(id: string, actorId: string, deviceId: string | null = null): boolean {
    return this.transaction(() => {
      const row = this.one<AssetRow & { library_id: string }>(
        `SELECT a.*, i.library_id FROM assets a JOIN items i ON i.id = a.item_id
         WHERE a.id = ? AND a.deleted_at IS NULL`,
        id,
      );
      if (!row) return false;
      const timestamp = nowIso();
      this.db
        .prepare('UPDATE assets SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(timestamp, timestamp, id);
      this.insertChange(
        'asset',
        id,
        'delete',
        row.library_id,
        row.item_id,
        row.shareable === 0,
        timestamp,
        deviceId,
      );
      this.insertAudit(actorId, 'delete-asset', 'asset', id, {});
      return true;
    });
  }

  manifest(itemId: string): { revision: number; files: AssetRecord[] } | null {
    const item = this.getItem(itemId);
    if (!item) return null;
    const rows = this.db
      .prepare(
        'SELECT * FROM assets WHERE item_id = ? AND deleted_at IS NULL ORDER BY relative_path',
      )
      .all(itemId) as unknown as AssetRow[];
    return { revision: item.revision, files: rows.map(mapAsset) };
  }

  changes(input: {
    after: number;
    limit: number;
    libraryIds: string[];
    includeSensitive: boolean;
    itemId: string | null;
    excludeDeviceId?: string | null;
  }): { changes: ChangeRecord[]; nextCursor: number } {
    if (input.libraryIds.length === 0) return { changes: [], nextCursor: input.after };
    const placeholders = input.libraryIds.map(() => '?').join(', ');
    const params: SQLInputValue[] = [input.after, ...input.libraryIds];
    let sql = `SELECT * FROM change_log WHERE cursor > ? AND library_id IN (${placeholders})`;
    if (!input.includeSensitive) sql += ' AND sensitive = 0';
    if (input.itemId) {
      sql += ' AND item_id = ?';
      params.push(input.itemId);
    }
    if (input.excludeDeviceId) {
      sql += ' AND (device_id IS NULL OR device_id != ?)';
      params.push(input.excludeDeviceId);
    }
    sql += ' ORDER BY cursor LIMIT ?';
    params.push(input.limit);
    const rows = this.db.prepare(sql).all(...params) as Array<{
      cursor: number;
      entity_type: string;
      entity_id: string;
      op: 'upsert' | 'delete';
      library_id: string | null;
      item_id: string | null;
      sensitive: number;
      recorded_at: string;
    }>;
    const changes = rows.map((row) => ({
      cursor: Number(row.cursor),
      entityType: row.entity_type,
      entityId: row.entity_id,
      op: row.op,
      libraryId: row.library_id,
      itemId: row.item_id,
      sensitive: row.sensitive === 1,
      recordedAt: row.recorded_at,
    }));
    const last = changes.at(-1);
    return { changes, nextCursor: last ? last.cursor : input.after };
  }

  visibleLibraryIds(actor: Actor): string[] {
    if (actor.kind === 'guest') return [actor.libraryId];
    const seeAll = actor.isOwner || actor.localTrust === true;
    return this.listLibraries(actor.userId, seeAll).map((library) => library.id);
  }

  createGuestGrant(input: {
    tokenHash: string;
    libraryId: string;
    itemId: string | null;
    capabilities: GuestCapability[];
    expiresAt: string;
    createdBy: string;
  }): { id: string } {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO guest_grants (
          id, token_hash, library_id, item_id, capabilities_json, expires_at, created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.tokenHash,
        input.libraryId,
        input.itemId,
        JSON.stringify(input.capabilities),
        input.expiresAt,
        nowIso(),
        input.createdBy,
      );
    this.insertAudit(input.createdBy, 'create-guest-grant', 'guest-grant', id, {
      libraryId: input.libraryId,
    });
    return { id };
  }

  /** The library used to authorize grant management, without exposing token material. */
  guestGrantLibraryId(id: string): string | null {
    const row = this.db.prepare('SELECT library_id FROM guest_grants WHERE id = ?').get(id) as
      | { library_id: string }
      | undefined;
    return row?.library_id ?? null;
  }

  revokeGuestGrant(id: string, actorId: string): boolean {
    const result = this.db
      .prepare('UPDATE guest_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(nowIso(), id);
    if (result.changes === 0) return false;
    this.insertAudit(actorId, 'revoke-guest-grant', 'guest-grant', id, {});
    return true;
  }

  /**
   * Grants the owner can review. The select names every column except
   * `token_hash`, so a list response cannot carry the secret or its digest.
   */
  listGuestGrants(limit: number): Array<{
    id: string;
    libraryId: string;
    itemId: string | null;
    capabilities: GuestCapability[];
    expiresAt: string;
    createdAt: string;
    revokedAt: string | null;
    createdBy: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, library_id, item_id, capabilities_json, expires_at, created_at,
           revoked_at, created_by
         FROM guest_grants ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(limit) as GuestGrantRow[];
    return rows.map((row) => ({
      id: row.id,
      libraryId: row.library_id,
      itemId: row.item_id,
      capabilities: parseCapabilities(row.capabilities_json),
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      createdBy: row.created_by,
    }));
  }

  createWebDavCredential(input: {
    userId: string;
    name: string;
    username: string;
    ha1Md5: string;
    ha1Sha256: string;
    expiresAt: string;
  }): WebDavCredentialRecord {
    if (
      !input.name ||
      input.name.trim() !== input.name ||
      input.name.length > 80 ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: labels must not contain controls
      /[\u0000-\u001f\u007f]/.test(input.name) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(input.username) ||
      !/^[a-f0-9]{32}$/.test(input.ha1Md5) ||
      !/^[a-f0-9]{64}$/.test(input.ha1Sha256) ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      input.expiresAt <= nowIso()
    ) {
      throw new DomainError('invalid-body', 400, 'Invalid WebDAV credential');
    }
    return this.transaction(() => {
      const count = this.one<{ count: number }>(
        'SELECT COUNT(*) AS count FROM webdav_credentials WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?',
        input.userId,
        nowIso(),
      );
      if ((count?.count ?? 0) >= 32)
        throw new DomainError('quota-exceeded', 409, 'Too many active WebDAV credentials');
      const credential: WebDavCredentialRecord = {
        id: randomUUID(),
        name: input.name,
        username: input.username,
        expiresAt: input.expiresAt,
        createdAt: nowIso(),
        revokedAt: null,
      };
      this.db
        .prepare(`INSERT INTO webdav_credentials
        (id,user_id,name,username,ha1_md5,ha1_sha256,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(
          credential.id,
          input.userId,
          input.name,
          input.username,
          input.ha1Md5,
          input.ha1Sha256,
          input.expiresAt,
          credential.createdAt,
        );
      this.insertAudit(
        input.userId,
        'create-webdav-credential',
        'webdav-credential',
        credential.id,
        { name: input.name },
      );
      return credential;
    });
  }

  listWebDavCredentials(userId: string): WebDavCredentialRecord[] {
    return this.db
      .prepare(`SELECT id,name,username,expires_at AS expiresAt,
      created_at AS createdAt,revoked_at AS revokedAt FROM webdav_credentials
      WHERE user_id = ? ORDER BY created_at,id`)
      .all(userId) as unknown as WebDavCredentialRecord[];
  }

  findWebDavCredential(username: string): {
    id: string;
    userId: string;
    accountUsername: string;
    isOwner: boolean;
    ha1Md5: string;
    ha1Sha256: string;
    expiresAt: string;
    revokedAt: string | null;
  } | null {
    const row = this.one<{
      id: string;
      userId: string;
      accountUsername: string;
      isOwner: number;
      ha1Md5: string;
      ha1Sha256: string;
      expiresAt: string;
      revokedAt: string | null;
    }>(
      `SELECT d.id,d.user_id AS userId,u.username AS accountUsername,u.is_owner AS isOwner,
       d.ha1_md5 AS ha1Md5,d.ha1_sha256 AS ha1Sha256,d.expires_at AS expiresAt,d.revoked_at AS revokedAt
       FROM webdav_credentials d JOIN users u ON u.id = d.user_id
       WHERE d.username = ? AND d.revoked_at IS NULL AND d.expires_at > ?`,
      username,
      nowIso(),
    );
    return row ? { ...row, isOwner: row.isOwner === 1 } : null;
  }

  revokeWebDavCredential(id: string, userId: string): boolean {
    const result = this.db
      .prepare(`UPDATE webdav_credentials SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
      .run(nowIso(), id, userId);
    if (result.changes === 0) return false;
    this.insertAudit(userId, 'revoke-webdav-credential', 'webdav-credential', id, {});
    return true;
  }

  createDeviceToken(input: {
    userId: string;
    name: string;
    tokenHash: string;
    scopes: ItemPermission[];
    expiresAt: string | null;
  }): { id: string } {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO device_tokens (
          id, user_id, name, token_hash, scopes_json, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.userId,
        input.name,
        input.tokenHash,
        JSON.stringify(input.scopes),
        input.expiresAt,
        nowIso(),
      );
    this.insertAudit(input.userId, 'create-device-token', 'device-token', id, { name: input.name });
    return { id };
  }

  revokeDeviceToken(id: string, userId: string): boolean {
    const result = this.db
      .prepare(
        'UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      )
      .run(nowIso(), id, userId);
    if (result.changes === 0) return false;
    this.insertAudit(userId, 'revoke-device-token', 'device-token', id, {});
    return true;
  }

  listAudit(limit: number): Array<{
    id: number;
    at: string;
    actorId: string | null;
    action: string;
    resourceType: string | null;
    resourceId: string | null;
  }> {
    const rows = this.db
      .prepare(
        'SELECT id, at, actor_id, action, resource_type, resource_id FROM audit_events ORDER BY id DESC LIMIT ?',
      )
      .all(limit) as Array<{
      id: number;
      at: string;
      actor_id: string | null;
      action: string;
      resource_type: string | null;
      resource_id: string | null;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      at: row.at,
      actorId: row.actor_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
    }));
  }

  auditContains(action: string, secret: string): boolean {
    const rows = this.db
      .prepare('SELECT detail_json FROM audit_events WHERE action = ?')
      .all(action) as Array<{ detail_json: string }>;
    return rows.some((row) => row.detail_json.includes(secret));
  }

  getIdempotency(
    actorKey: string,
    key: string,
  ): { requestHash: string; statusCode: number; responseJson: string } | null {
    const row = this.one<{ request_hash: string; status_code: number; response_json: string }>(
      'SELECT request_hash, status_code, response_json FROM idempotency_keys WHERE actor_key = ? AND idempotency_key = ?',
      actorKey,
      key,
    );
    if (!row) return null;
    return {
      requestHash: row.request_hash,
      statusCode: Number(row.status_code),
      responseJson: row.response_json,
    };
  }

  saveIdempotency(input: {
    actorKey: string;
    key: string;
    requestHash: string;
    statusCode: number;
    responseJson: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_keys (
          actor_key, idempotency_key, request_hash, status_code, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.actorKey,
        input.key,
        input.requestHash,
        input.statusCode,
        input.responseJson,
        nowIso(),
      );
  }

  private migrate(): void {
    for (const migration of pendingMigrations(this.appliedVersions())) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, nowIso());
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  private appliedVersions(): ReadonlySet<number> | null {
    const ledger = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() as { name: string } | undefined;
    if (!ledger) return null;
    const rows = this.db.prepare('SELECT version FROM schema_migrations').all() as {
      version: number;
    }[];
    return new Set(rows.map((row) => Number(row.version)));
  }

  private serverRow(): { serverId: string; displayName: string; bootstrapped: boolean } {
    const row = this.one<{
      server_id: string;
      display_name: string;
      bootstrapped_at: string | null;
    }>('SELECT server_id, display_name, bootstrapped_at FROM server_state WHERE id = 1');
    if (!row) throw new DomainError('uninitialized', 500, 'Server state is missing');
    return {
      serverId: row.server_id,
      displayName: row.display_name,
      bootstrapped: row.bootstrapped_at !== null,
    };
  }

  private insertSession(userId: string, sessionHash: string, createdAt: string): string {
    const expiresAt = futureIso(this.limits.sessionTtlMs);
    this.db
      .prepare(
        'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(randomUUID(), userId, sessionHash, expiresAt, createdAt);
    return expiresAt;
  }

  private insertChange(
    entityType: string,
    entityId: string,
    op: 'upsert' | 'delete',
    libraryId: string | null,
    itemId: string | null,
    sensitive: boolean,
    recordedAt: string,
    deviceId: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO change_log (
          entity_type, entity_id, op, library_id, item_id, sensitive, recorded_at, device_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entityType, entityId, op, libraryId, itemId, sensitive ? 1 : 0, recordedAt, deviceId);
  }

  private insertAudit(
    actorId: string | null,
    action: string,
    resourceType: string | null,
    resourceId: string | null,
    detail: Record<string, string>,
  ): void {
    this.db
      .prepare(
        'INSERT INTO audit_events (at, actor_id, action, resource_type, resource_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(nowIso(), actorId, action, resourceType, resourceId, JSON.stringify(detail));
  }

  private itemRow(id: string): ItemRow | undefined {
    return this.one<ItemRow>('SELECT * FROM items WHERE id = ?', id);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
}

type StorageLocationRow = {
  id: string;
  label: string;
  path: string;
  created_at: string;
};

interface ItemRow {
  id: string;
  library_id: string;
  system_identifier: string;
  title: string;
  md5: string | null;
  crc: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface AssetRow {
  id: string;
  item_id: string;
  kind: AssetKind;
  display_name: string;
  relative_path: string;
  sha256: string;
  size: number;
  md5: string | null;
  crc: string | null;
  shareable: number;
  revision: number;
  created_at: string;
  updated_at: string;
  conflict_of: string | null;
}

type ContentRootRow = {
  id: string;
  path: string;
  label: string;
  library_id: string | null;
  created_at: string;
};

type SourceRow = {
  id: string;
  root_id: string;
  library_id: string | null;
  relative_path: string;
  display_name: string;
  size: number;
  blocks: number;
  kind: string;
  system_id: string | null;
  availability: string;
};

function mapSource(row: SourceRow): SourceFileRecord {
  return {
    id: row.id,
    rootId: row.root_id,
    libraryId: row.library_id,
    relativePath: row.relative_path,
    displayName: row.display_name,
    size: row.size,
    blocks: row.blocks,
    kind: row.kind as SourceFileRecord['kind'],
    systemId: row.system_id,
    availability: row.availability as SourceAvailability,
  };
}

function assertSourcePath(path: string): void {
  if (!path || path.startsWith('/') || path.split('/').includes('..')) {
    throw new DomainError('invalid-body', 400, 'A scanned path must stay inside the folder');
  }
}

function assertSourceKind(kind: string): void {
  if (
    kind !== 'rom' &&
    kind !== 'battery_save' &&
    kind !== 'save_state' &&
    kind !== 'screenshot' &&
    kind !== 'artwork' &&
    kind !== 'bios' &&
    kind !== 'system_file'
  ) {
    throw new DomainError('invalid-body', 400, 'Source kind is not supported');
  }
}

function sensitiveKind(kind: string): boolean {
  return kind === 'bios' || kind === 'system_file';
}

type GuestGrantRow = {
  id: string;
  library_id: string;
  item_id: string | null;
  capabilities_json: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  created_by: string;
};

function mapContentRoot(row: ContentRootRow): ContentRootRecord {
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    libraryId: row.library_id,
    createdAt: row.created_at,
  };
}

function mapLibrary(row: {
  id: string;
  name: string;
  owner_id: string;
  revision: number;
  created_at: string;
}): LibraryRecord {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    revision: Number(row.revision),
    createdAt: row.created_at,
  };
}

function mapItem(row: ItemRow): ItemRecord {
  return {
    id: row.id,
    libraryId: row.library_id,
    systemIdentifier: row.system_identifier,
    title: row.title,
    md5: row.md5,
    crc: row.crc,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAsset(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind,
    displayName: row.display_name,
    relativePath: row.relative_path,
    sha256: row.sha256,
    size: Number(row.size),
    md5: row.md5,
    crc: row.crc,
    shareable: row.shareable === 1,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    conflictOf: row.conflict_of ?? null,
  };
}

function parsePermissions(value: string): ItemPermission[] {
  const allowed = new Set<ItemPermission>(['read', 'write', 'admin']);
  return parseStrings(value).filter((item): item is ItemPermission =>
    allowed.has(item as ItemPermission),
  );
}

function parseCapabilities(value: string): GuestCapability[] {
  const allowed = new Set<GuestCapability>(['read', 'write', 'share_restricted']);
  return parseStrings(value).filter((item): item is GuestCapability =>
    allowed.has(item as GuestCapability),
  );
}

function parseStrings(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string');
}
