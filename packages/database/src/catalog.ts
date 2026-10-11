import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  type Actor,
  type AssetKind,
  type AssetRecord,
  DomainError,
  type GuestCapability,
  type ItemPermission,
  type ItemRecord,
  type LibraryRecord,
  type LibraryRole,
} from '@ecs/domain';
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

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export class CatalogDatabase {
  readonly limits: CatalogLimits;
  private readonly db: DatabaseSync;

  constructor(filename: string, limits: Partial<CatalogLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
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
    const rows = this.db.prepare('SELECT sha256 FROM blobs').all() as Array<{ sha256: string }>;
    return rows.map((row) => row.sha256);
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
      this.insertChange('library', libraryId, 'upsert', libraryId, null, false, createdAt);
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

  createLibrary(ownerId: string, name: string): LibraryRecord {
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
      this.insertChange('library', id, 'upsert', id, null, false, createdAt);
      this.insertAudit(ownerId, 'create-library', 'library', id, { name });
    });
    return { id, name, ownerId, revision: 1, createdAt };
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
      this.insertChange('item', id, 'upsert', input.libraryId, id, false, timestamp);
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
      this.insertChange('item', input.id, 'upsert', current.library_id, input.id, false, timestamp);
      this.insertAudit(input.actorId, 'update-item', 'item', input.id, {});
      const updated = this.itemRow(input.id);
      if (!updated) throw new DomainError('not-found', 404, 'Item not found');
      return mapItem(updated);
    });
  }

  deleteItem(id: string, actorId: string): boolean {
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
      this.insertChange('item', id, 'delete', current.library_id, id, false, timestamp);
      this.insertAudit(actorId, 'delete-item', 'item', id, {});
      return true;
    });
  }

  listItems(input: {
    libraryId: string;
    afterId: string | null;
    limit: number;
    itemId: string | null;
  }): { items: ItemRecord[]; nextCursor: string | null } {
    const params: SQLInputValue[] = [input.libraryId];
    let sql = 'SELECT * FROM items WHERE library_id = ? AND deleted_at IS NULL';
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
          'INSERT INTO blobs (sha256, size, md5, crc, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING',
        )
        .run(input.sha256, input.size, input.md5, input.crc, timestamp);
      const assetId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO assets (
            id, item_id, kind, display_name, relative_path, sha256, size, md5, crc, shareable,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          assetId,
          input.itemId,
          input.kind,
          input.displayName,
          input.relativePath,
          input.sha256,
          input.size,
          input.md5,
          input.crc,
          input.shareable ? 1 : 0,
          timestamp,
          timestamp,
        );
      const updated = this.db
        .prepare(
          `UPDATE items SET revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        )
        .run(timestamp, input.itemId, input.baseRevision);
      if (updated.changes === 0)
        throw new DomainError('conflict', 409, 'Item revision does not match');
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
      );
      this.insertAudit(input.actorId, 'complete-upload', 'asset', assetId, {
        sha256: input.sha256,
      });
      const asset = this.getAsset(assetId);
      if (!asset) throw new DomainError('not-found', 404, 'Asset not found');
      return asset;
    });
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

  deleteAsset(id: string, actorId: string): boolean {
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
    return this.listLibraries(actor.userId, actor.isOwner).map((library) => library.id);
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

  revokeGuestGrant(id: string, actorId: string): boolean {
    const result = this.db
      .prepare('UPDATE guest_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(nowIso(), id);
    if (result.changes === 0) return false;
    this.insertAudit(actorId, 'revoke-guest-grant', 'guest-grant', id, {});
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
  ): void {
    this.db
      .prepare(
        `INSERT INTO change_log (
          entity_type, entity_id, op, library_id, item_id, sensitive, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entityType, entityId, op, libraryId, itemId, sensitive ? 1 : 0, recordedAt);
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
