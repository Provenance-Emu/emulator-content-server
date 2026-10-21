import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  Actor,
  AssetRecord,
  ContentRootRecord,
  ItemRecord,
  SourceFileRecord,
} from '@ecs/domain';
import { DomainError } from '@ecs/domain';

export interface BrowsePosition {
  entityType: 'item' | 'asset' | 'source';
  id: string;
}
export interface BrowseSelection {
  actor: Actor;
  libraryId: string | null;
  category: 'games' | 'saves' | 'media' | 'system_files';
  rootId?: string | null;
  /** Null/omitted selects every system; 'unknown' selects uncategorized systems. */
  systemId?: string | null;
  systemIds?: string[];
  search?: string;
  sort: 'name_asc' | 'name_desc';
  limit: number;
  position?: BrowsePosition | null;
}
export type BrowseRecord =
  | { entityType: 'item'; item: ItemRecord; previewAsset: AssetRecord | null }
  | { entityType: 'asset'; asset: AssetRecord; item: ItemRecord }
  | { entityType: 'source'; source: SourceFileRecord };
export interface RootSummaryFilter {
  actor: Actor;
  libraryId?: string | null;
}
export interface ContentRootSummaryRecord extends ContentRootRecord {
  indexedFileCount: number;
  lastCheckedAt: string | null;
  availability: 'unknown' | 'online' | 'offline';
  medium: string | null;
  scanState: 'unknown' | 'pending' | 'completed' | 'failed';
  lastScanStartedAt: string | null;
  lastScanCompletedAt: string | null;
  scanError: string | null;
}

// SQL owns selection and pagination. Only the selected page is hydrated into domain records.

function projectionFor(input: BrowseSelection): { projection: string; params: SQLInputValue[] } {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new DomainError('invalid-query', 400, 'Browse limit must be between 1 and 100');
  const actor = input.actor;
  const guest = actor.kind === 'guest';
  const read = guest ? actor.capabilities.includes('read') : actor.scopes.includes('read');
  const params: SQLInputValue[] = [
    input.libraryId,
    !guest && actor.isOwner ? 1 : 0,
    read ? 1 : 0,
    !guest && (actor.isOwner || actor.localTrust === true) ? 1 : 0,
    !guest ? actor.userId : null,
    guest ? 1 : 0,
    guest ? actor.libraryId : null,
    guest ? actor.itemId : null,
    guest && actor.capabilities.includes('share_restricted') ? 1 : 0,
    input.rootId ?? null,
    JSON.stringify(
      input.systemIds !== undefined ? input.systemIds : input.systemId ? [input.systemId] : [],
    ),
    `%${(input.search ?? '')
      .normalize('NFC')
      .toLowerCase()
      .replace(/[\\%_]/g, '\\$&')}%`,
  ];
  const kinds = {
    games: "'rom'",
    saves: "'battery_save','save_state'",
    media: "'artwork','screenshot'",
    system_files: "'bios','system_file'",
  }[input.category];
  if (!kinds || (input.sort !== 'name_asc' && input.sort !== 'name_desc')) {
    throw new DomainError('invalid-query', 400, 'Invalid browse selection');
  }
  const itemAccess = `c.can_read = 1 AND (
    (c.is_guest = 1 AND i.library_id = c.guest_library AND (c.guest_item IS NULL OR i.id = c.guest_item))
    OR (c.is_guest = 0 AND (c.see_all = 1
      OR EXISTS (SELECT 1 FROM memberships m WHERE m.library_id = i.library_id AND m.user_id = c.user_id)
      OR EXISTS (SELECT 1 FROM item_acl acl WHERE acl.item_id = i.id AND acl.user_id = c.user_id AND acl.permission = 'read'))))`;
  const assetAccess = (alias: string) =>
    `(c.is_guest = 0 OR c.restricted = 1 OR (${alias}.shareable = 1 AND ${alias}.kind NOT IN ('bios','system_file')))`;
  const system = (column: string) => `(json_array_length(c.system_ids) = 0 OR EXISTS (
    SELECT 1 FROM json_each(c.system_ids) selected WHERE selected.value = COALESCE(NULLIF(${column},''),'unknown')))`;
  const projection = `WITH c AS (SELECT ? AS library_id, ? AS is_owner, ? AS can_read,
    ? AS see_all, ? AS user_id, ? AS is_guest, ? AS guest_library, ? AS guest_item,
    ? AS restricted, ? AS root_id, ? AS system_ids, ? AS search),
  eligible AS (
    SELECT 'item' AS entity_type, i.id, ecs_browse_fold(i.title) AS folded_name, COALESCE(NULLIF(i.system_identifier,''),'unknown') AS system_id,
      (SELECT p.id FROM assets p WHERE p.item_id = i.id AND p.deleted_at IS NULL
       AND p.kind = 'artwork' AND ${assetAccess('p')} ORDER BY p.id LIMIT 1) AS preview_id
    FROM items i JOIN libraries l ON l.id = i.library_id CROSS JOIN c
    WHERE ${input.category === 'games' ? '1' : '0'} = 1
      AND i.library_id = c.library_id AND l.deleted_at IS NULL AND i.deleted_at IS NULL
      AND c.root_id IS NULL AND ${itemAccess} AND ${system('i.system_identifier')}
      AND ecs_browse_fold(i.title) LIKE c.search ESCAPE '\\'
      AND (EXISTS (SELECT 1 FROM assets r WHERE r.item_id = i.id AND r.deleted_at IS NULL
        AND r.kind = 'rom' AND ${assetAccess('r')})
        OR NOT EXISTS (SELECT 1 FROM assets a WHERE a.item_id = i.id AND a.deleted_at IS NULL))
    UNION ALL
    SELECT 'asset', a.id, ecs_browse_fold(a.display_name), COALESCE(NULLIF(i.system_identifier,''),'unknown'), NULL
    FROM assets a JOIN items i ON i.id = a.item_id JOIN libraries l ON l.id = i.library_id CROSS JOIN c
    WHERE ${input.category === 'games' ? '0' : '1'} = 1
      AND i.library_id = c.library_id AND l.deleted_at IS NULL AND i.deleted_at IS NULL AND a.deleted_at IS NULL
      AND c.root_id IS NULL AND ${itemAccess} AND ${assetAccess('a')} AND a.kind IN (${kinds})
      AND ${system('i.system_identifier')} AND ecs_browse_fold(a.display_name) LIKE c.search ESCAPE '\\'
    UNION ALL
    SELECT 'source', s.id, ecs_browse_fold(s.display_name), COALESCE(NULLIF(s.system_id,''),'unknown'), NULL
    FROM source_files s JOIN content_roots r ON r.id = s.root_id CROSS JOIN c
    WHERE c.can_read = 1 AND (c.root_id IS NULL OR s.root_id = c.root_id)
      AND ((r.library_id = c.library_id AND EXISTS (SELECT 1 FROM libraries l WHERE l.id = r.library_id AND l.deleted_at IS NULL))
        OR (c.library_id IS NULL AND r.library_id IS NULL AND c.is_owner = 1))
      AND ((c.is_guest = 0 AND (c.see_all = 1 OR EXISTS (SELECT 1 FROM memberships m WHERE m.library_id = r.library_id AND m.user_id = c.user_id)))
        OR (c.is_guest = 1 AND r.library_id = c.guest_library AND c.guest_item IS NULL))
      AND (c.is_guest = 0 OR c.restricted = 1 OR s.kind NOT IN ('bios','system_file'))
      AND ${input.category === 'games' ? 's.group_anchor IS NULL' : '1'}
      AND s.kind IN (${kinds}) AND ${system('s.system_id')}
      AND ecs_browse_fold(s.display_name) LIKE c.search ESCAPE '\\'
  )`;
  return { projection, params };
}
export function browseSystemCounts(
  db: DatabaseSync,
  input: BrowseSelection,
): { systemId: string; count: number }[] {
  const { projection, params } = projectionFor({
    ...input,
    category: 'games',
    systemId: null,
    systemIds: [],
  });
  const rows = db
    .prepare(
      `${projection} SELECT system_id AS systemId, COUNT(*) AS count FROM eligible GROUP BY system_id ORDER BY system_id`,
    )
    .all(...params) as { systemId: string; count: number }[];
  return rows.map((row) => ({ systemId: row.systemId, count: row.count }));
}
export function browseKeys(
  db: DatabaseSync,
  input: BrowseSelection,
): { entity_type: BrowsePosition['entityType']; id: string; preview_id: string | null }[] {
  const { projection, params } = projectionFor(input);
  // Both anchor and page use the same projection so revoked access or changed filters
  // cannot retain a formerly readable name in a keyset comparison.
  const direction = input.sort === 'name_desc' ? 'DESC' : 'ASC';
  const comparison = input.sort === 'name_desc' ? '<' : '>';
  let after = '';
  if (input.position) {
    const anchor = db
      .prepare(`${projection} SELECT folded_name FROM eligible WHERE entity_type = ? AND id = ?`)
      .get(...params, input.position.entityType, input.position.id) as
      | { folded_name: string }
      | undefined;
    if (!anchor)
      throw new DomainError('invalid-cursor', 400, 'This page has changed. Refresh the library.');
    after = `WHERE (folded_name, entity_type, id) ${comparison} (?, ?, ?)`;
    params.push(anchor.folded_name, input.position.entityType, input.position.id);
  }
  return db
    .prepare(`${projection} SELECT entity_type, id, preview_id FROM eligible ${after}
    ORDER BY folded_name ${direction}, entity_type ${direction}, id ${direction} LIMIT ?`)
    .all(...params, input.limit + 1) as Array<{
    entity_type: BrowsePosition['entityType'];
    id: string;
    preview_id: string | null;
  }>;
}
