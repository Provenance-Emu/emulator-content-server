import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { DomainError } from '@ecs/domain';

/** How long a deleted game or file can still be restored. */
export const TRASH_RETENTION_DAYS = 30;

/** The date written on a row when it is deleted. It is never recomputed. */
export function purgeDate(deletedAt: string): string {
  return new Date(Date.parse(deletedAt) + TRASH_RETENTION_DAYS * 86_400_000).toISOString();
}

export interface TrashEntryRecord {
  kind: 'item' | 'file';
  id: string;
  name: string;
  libraryId: string;
  itemId: string;
  itemTitle: string;
  systemIdentifier: string;
  /** Bytes that come back on restore. */
  size: number;
  fileCount: number;
  deletedAt: string;
  deletedBy: string | null;
  deletedByName: string | null;
  purgeAfter: string;
  /** A file whose game is also in the trash cannot be restored before the game. */
  itemDeleted: boolean;
}

export interface TrashPosition {
  deletedAt: string;
  id: string;
}

export interface PurgeResult {
  items: number;
  files: number;
  /** Uploads that were still open on a purged guest link. Their staging files are now orphans. */
  openUploads: string[];
}

interface TrashHooks {
  transaction<T>(fn: () => T): T;
  change(
    entityType: 'item' | 'asset',
    entityId: string,
    libraryId: string,
    itemId: string,
    sensitive: boolean,
    recordedAt: string,
    deviceId: string | null,
  ): void;
  audit(actorId: string | null, action: string, resourceType: string, resourceId: string): void;
  librarySize(libraryId: string): number;
  maxLibraryBytes: number;
}

interface DeletedItem {
  id: string;
  library_id: string;
  deleted_at: string | null;
}

interface DeletedAsset {
  id: string;
  item_id: string;
  library_id: string;
  item_deleted_at: string | null;
  display_name: string;
  relative_path: string;
  size: number;
  shareable: number;
  conflict_of: string | null;
  deleted_at: string | null;
}

const TRASH_ROWS = `
  SELECT 'item' AS kind, i.id, i.title AS name, i.library_id, i.id AS item_id, i.title AS item_title,
    i.system_identifier,
    (SELECT COALESCE(SUM(a.size),0) FROM assets a WHERE a.item_id=i.id AND a.deleted_at=i.deleted_at) AS size,
    (SELECT COUNT(*) FROM assets a WHERE a.item_id=i.id AND a.deleted_at=i.deleted_at) AS file_count,
    i.deleted_at, i.deleted_by, i.purge_after, 0 AS item_deleted
  FROM items i WHERE i.deleted_at IS NOT NULL
  UNION ALL
  SELECT 'file', a.id, a.display_name, i.library_id, i.id, i.title, i.system_identifier, a.size, 1,
    a.deleted_at, a.deleted_by, a.purge_after, i.deleted_at IS NOT NULL
  FROM assets a JOIN items i ON i.id=a.item_id
  WHERE a.deleted_at IS NOT NULL AND (i.deleted_at IS NULL OR a.deleted_at<>i.deleted_at)`;

/**
 * Deleted games and files between deletion and purge.
 *
 * A game deleted with its files is one entry: the files share the game's
 * `deleted_at`, and that equality is what ties them together on restore.
 */
export class TrashRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly hooks: TrashHooks,
  ) {}

  list(input: { libraryId: string | null; after: TrashPosition | null; limit: number }): {
    entries: TrashEntryRecord[];
    next: TrashPosition | null;
  } {
    const params: SQLInputValue[] = [];
    let where = 'WHERE 1=1';
    if (input.libraryId) {
      where += ' AND t.library_id=?';
      params.push(input.libraryId);
    }
    if (input.after) {
      where += ' AND (t.deleted_at<? OR (t.deleted_at=? AND t.id<?))';
      params.push(input.after.deletedAt, input.after.deletedAt, input.after.id);
    }
    params.push(input.limit);
    const rows = this.db
      .prepare(
        `SELECT t.*, u.username AS deleted_by_name FROM (${TRASH_ROWS}) t
         LEFT JOIN users u ON u.id=t.deleted_by ${where}
         ORDER BY t.deleted_at DESC, t.id DESC LIMIT ?`,
      )
      .all(...params) as Array<Record<string, string | number | null>>;
    const entries = rows.map(
      (row): TrashEntryRecord => ({
        kind: row.kind === 'item' ? 'item' : 'file',
        id: String(row.id),
        name: String(row.name),
        libraryId: String(row.library_id),
        itemId: String(row.item_id),
        itemTitle: String(row.item_title),
        systemIdentifier: String(row.system_identifier),
        size: Number(row.size),
        fileCount: Number(row.file_count),
        deletedAt: String(row.deleted_at),
        deletedBy: row.deleted_by === null ? null : String(row.deleted_by),
        deletedByName: row.deleted_by_name === null ? null : String(row.deleted_by_name),
        purgeAfter: String(row.purge_after),
        itemDeleted: Number(row.item_deleted) === 1,
      }),
    );
    const last = entries.at(-1);
    return {
      entries,
      next:
        entries.length === input.limit && last ? { deletedAt: last.deletedAt, id: last.id } : null,
    };
  }

  /** Returns false when the game was already live. Throws when it no longer exists. */
  restoreItem(id: string, actorId: string, deviceId: string | null): boolean {
    return this.hooks.transaction(() => {
      const item = this.db
        .prepare('SELECT id, library_id, deleted_at FROM items WHERE id=?')
        .get(id) as DeletedItem | undefined;
      if (!item) throw new DomainError('not-found', 404, 'Item not found');
      if (!item.deleted_at) return false;
      const files = this.db
        .prepare('SELECT id, size, shareable FROM assets WHERE item_id=? AND deleted_at=?')
        .all(id, item.deleted_at) as Array<{ id: string; size: number; shareable: number }>;
      this.requireRoom(
        item.library_id,
        files.reduce((total, file) => total + Number(file.size), 0),
      );
      const timestamp = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE items SET deleted_at=NULL, deleted_by=NULL, purge_after=NULL,
             revision=revision+1, updated_at=? WHERE id=?`,
        )
        .run(timestamp, id);
      this.db
        .prepare(
          `UPDATE assets SET deleted_at=NULL, deleted_by=NULL, purge_after=NULL, updated_at=?
             WHERE item_id=? AND deleted_at=?`,
        )
        .run(timestamp, id, item.deleted_at);
      this.hooks.change('item', id, item.library_id, id, false, timestamp, deviceId);
      for (const file of files) {
        this.hooks.change(
          'asset',
          file.id,
          item.library_id,
          id,
          file.shareable === 0,
          timestamp,
          deviceId,
        );
      }
      this.hooks.audit(actorId, 'restore-item', 'item', id);
      return true;
    });
  }

  /** Returns false when the file was already live. Throws when it no longer exists. */
  restoreAsset(id: string, actorId: string, deviceId: string | null): boolean {
    return this.hooks.transaction(() => {
      const file = this.db
        .prepare(
          `SELECT a.id, a.item_id, a.display_name, a.relative_path, a.size, a.shareable,
             a.conflict_of, a.deleted_at, i.library_id, i.deleted_at AS item_deleted_at
           FROM assets a JOIN items i ON i.id=a.item_id WHERE a.id=?`,
        )
        .get(id) as DeletedAsset | undefined;
      if (!file) throw new DomainError('not-found', 404, 'File not found');
      if (!file.deleted_at) return false;
      if (file.item_deleted_at) {
        throw new DomainError('conflict', 409, 'Restore the game first');
      }
      this.requireRoom(file.library_id, Number(file.size));
      const timestamp = new Date().toISOString();
      // Something uploaded since may hold this path. It stays where it is and
      // the restored bytes return beside it, for a person to choose between.
      const occupant = file.conflict_of
        ? undefined
        : (this.db
            .prepare(
              `SELECT id FROM assets WHERE item_id=? AND relative_path=? AND conflict_of IS NULL
                 AND deleted_at IS NULL`,
            )
            .get(file.item_id, file.relative_path) as { id: string } | undefined);
      this.db
        .prepare(
          `UPDATE assets SET deleted_at=NULL, deleted_by=NULL, purge_after=NULL, updated_at=?,
             relative_path=?, display_name=?, conflict_of=? WHERE id=?`,
        )
        .run(
          timestamp,
          occupant ? `${file.relative_path}.conflict-${id.slice(0, 8)}` : file.relative_path,
          occupant ? `${file.display_name} (conflict)` : file.display_name,
          occupant ? occupant.id : file.conflict_of,
          id,
        );
      this.hooks.change(
        'asset',
        id,
        file.library_id,
        file.item_id,
        file.shareable === 0,
        timestamp,
        deviceId,
      );
      this.hooks.audit(actorId, 'restore-asset', 'asset', id);
      return true;
    });
  }

  /**
   * Removes rows whose `purge_after` has passed. This is the only step in the
   * trash that cannot be undone. A game row goes once none of its file rows
   * remain, so a batch limit can never orphan a file.
   */
  purgeExpired(now: string, limit: number): PurgeResult {
    return this.hooks.transaction(() => {
      const files = this.db
        .prepare(
          `SELECT id FROM assets WHERE deleted_at IS NOT NULL AND purge_after<=?
           ORDER BY purge_after LIMIT ?`,
        )
        .all(now, limit) as Array<{ id: string }>;
      for (const file of files) {
        // A copy kept beside a purged file stands on its own now. Tell devices.
        const copies = this.db
          .prepare(
            `SELECT a.id, a.item_id, a.shareable, i.library_id FROM assets a
             JOIN items i ON i.id=a.item_id WHERE a.conflict_of=?`,
          )
          .all(file.id) as Array<{
          id: string;
          item_id: string;
          shareable: number;
          library_id: string;
        }>;
        this.db
          .prepare('UPDATE assets SET conflict_of=NULL, updated_at=? WHERE conflict_of=?')
          .run(now, file.id);
        for (const copy of copies) {
          this.hooks.change(
            'asset',
            copy.id,
            copy.library_id,
            copy.item_id,
            copy.shareable === 0,
            now,
            null,
          );
        }
        this.db.prepare('DELETE FROM assets WHERE id=?').run(file.id);
        this.hooks.audit(null, 'purge', 'asset', file.id);
      }
      const items = this.db
        .prepare(
          `SELECT id FROM items WHERE deleted_at IS NOT NULL AND purge_after<=?
             AND NOT EXISTS(SELECT 1 FROM assets a WHERE a.item_id=items.id)
           ORDER BY purge_after LIMIT ?`,
        )
        .all(now, limit) as Array<{ id: string }>;
      const openUploads: string[] = [];
      for (const item of items) {
        // A guest link names one game. It cannot outlive the game, and it must
        // not be widened to the library by clearing its game instead.
        const uploads = this.db
          .prepare(
            `SELECT id, state FROM uploads WHERE guest_grant_id IN
               (SELECT id FROM guest_grants WHERE item_id=?)`,
          )
          .all(item.id) as Array<{ id: string; state: string }>;
        for (const upload of uploads) {
          if (upload.state === 'open') openUploads.push(upload.id);
          this.db.prepare('DELETE FROM uploads WHERE id=?').run(upload.id);
        }
        this.db.prepare('DELETE FROM guest_grants WHERE item_id=?').run(item.id);
        this.db.prepare('DELETE FROM item_acl WHERE item_id=?').run(item.id);
        this.db.prepare('DELETE FROM items WHERE id=?').run(item.id);
        this.hooks.audit(null, 'purge', 'item', item.id);
      }
      return { items: items.length, files: files.length, openUploads };
    });
  }

  /** Blobs no file row names, live or in the trash. `after` skips ones that failed this run. */
  unreferencedBlobs(
    limit: number,
    after: string | null,
  ): { sha256: string; locationId: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT b.sha256, b.location_id FROM blobs b
         WHERE b.sha256>? AND NOT EXISTS(SELECT 1 FROM assets a WHERE a.sha256=b.sha256)
         ORDER BY b.sha256 LIMIT ?`,
      )
      .all(after ?? '', limit) as Array<{ sha256: string; location_id: string | null }>;
    return rows.map((row) => ({ sha256: row.sha256, locationId: row.location_id }));
  }

  /** Whether any file row, live or in the trash, still names these bytes. */
  blobReferenced(sha256: string): boolean {
    return this.db.prepare('SELECT 1 FROM assets WHERE sha256=? LIMIT 1').get(sha256) !== undefined;
  }

  /** Drops the blob row only while nothing names it. The check and the delete are one statement. */
  forgetBlob(sha256: string): boolean {
    const result = this.db
      .prepare(
        `DELETE FROM blobs WHERE sha256=?
           AND NOT EXISTS(SELECT 1 FROM assets a WHERE a.sha256=blobs.sha256)`,
      )
      .run(sha256);
    return Number(result.changes) > 0;
  }

  private requireRoom(libraryId: string, bytes: number): void {
    if (this.hooks.librarySize(libraryId) + bytes > this.hooks.maxLibraryBytes) {
      throw new DomainError('quota-exceeded', 413, 'Library byte quota would be exceeded');
    }
  }
}
