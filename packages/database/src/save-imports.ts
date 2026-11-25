import type { DatabaseSync } from 'node:sqlite';

/** The game a digest belongs to: an existing game, or a scanned file that has no game entry yet. */
export type GameForDigest = { itemId: string } | { sourceId: string };

export interface SaveImportRecord {
  /** Where the record lives, for example `icloud:<container>`. */
  origin: string;
  recordName: string;
  changeTag: string;
  assetId: string | null;
  device: string | null;
  modifiedAt: string | null;
}

/**
 * Finds the game a ROM digest names. Uploaded games first, then a ROM among an uploaded game's
 * files, then a scanned file whose digest has been worked out. A scanned file that already
 * belongs to a game answers with that game.
 */
export function gameForMd5(db: DatabaseSync, md5: string): GameForDigest | null {
  if (!/^[0-9a-f]{32}$/i.test(md5)) return null;
  const lower = md5.toLowerCase();
  const upper = md5.toUpperCase();
  const item = db
    .prepare(
      'SELECT id FROM items WHERE md5 IN (?, ?) AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1',
    )
    .get(lower, upper) as { id: string } | undefined;
  if (item) return { itemId: item.id };
  const file = db
    .prepare(`SELECT a.item_id AS id FROM assets a JOIN items i ON i.id = a.item_id
      WHERE a.md5 IN (?, ?) AND a.kind = 'rom' AND a.deleted_at IS NULL AND i.deleted_at IS NULL
      ORDER BY a.created_at, a.id LIMIT 1`)
    .get(lower, upper) as { id: string } | undefined;
  if (file) return { itemId: file.id };
  const source = db
    .prepare(`SELECT s.id AS source_id,
        (SELECT g.item_id FROM game_source_copies g JOIN items i ON i.id = g.item_id
         WHERE g.source_id = s.id AND i.deleted_at IS NULL AND i.library_id = r.library_id) AS item_id
      FROM source_fingerprints f JOIN live_source_files s ON s.id = f.source_id
      JOIN content_roots r ON r.id = s.root_id
      WHERE f.md5 = ? AND s.kind = 'rom' AND s.group_anchor IS NULL AND r.library_id IS NOT NULL
      ORDER BY item_id IS NULL, s.id LIMIT 1`)
    .get(lower) as { source_id: string; item_id: string | null } | undefined;
  if (!source) return null;
  return source.item_id ? { itemId: source.item_id } : { sourceId: source.source_id };
}

/** Every record already brought in from one origin, as `recordName` + newline + `changeTag`. */
export function importedSaveKeys(db: DatabaseSync, origin: string): Set<string> {
  const rows = db
    .prepare('SELECT record_name, change_tag FROM save_imports WHERE origin = ?')
    .all(origin) as Array<{ record_name: string; change_tag: string }>;
  return new Set(rows.map((row) => saveImportKey(row.record_name, row.change_tag)));
}

export function saveImportKey(recordName: string, changeTag: string): string {
  return `${recordName}\n${changeTag}`;
}

export function recordSaveImport(
  db: DatabaseSync,
  input: SaveImportRecord,
  importedAt: string,
): void {
  db.prepare(`INSERT INTO save_imports
      (origin, record_name, change_tag, asset_id, device, modified_at, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(origin, record_name, change_tag) DO NOTHING`).run(
    input.origin,
    input.recordName,
    input.changeTag,
    input.assetId,
    input.device,
    input.modifiedAt,
    importedAt,
  );
}

/** A live save on this game that already holds exactly these bytes. */
export function liveSaveWithDigest(
  db: DatabaseSync,
  itemId: string,
  sha256: string,
): string | null {
  const row = db
    .prepare(`SELECT id FROM assets WHERE item_id = ? AND sha256 = ? AND deleted_at IS NULL
      AND kind IN ('save_state', 'battery_save') ORDER BY created_at, id LIMIT 1`)
    .get(itemId, sha256) as { id: string } | undefined;
  return row?.id ?? null;
}
