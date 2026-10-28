import type { DatabaseSync } from 'node:sqlite';
import {
  DomainError,
  type SourceArtworkRole,
  type SourceMatchRecord,
  type SourceMatchState,
} from '@ecs/domain';

const ARTWORK_ROLES: readonly SourceArtworkRole[] = [
  'front',
  'back',
  'disc',
  'manual',
  'title',
  'screenshot',
  'other',
];

export const sourceTitleSql = `COALESCE((SELECT json_extract(sm.selection_json,'$.title') FROM source_match_selections sm WHERE sm.source_id=s.id AND sm.kind='metadata'),s.display_name)`;
export const sourceSystemSql = `COALESCE((SELECT NULLIF(json_extract(sm.selection_json,'$.metadata.systemId'),'') FROM source_match_selections sm WHERE sm.source_id=s.id AND sm.kind IN ('rom','metadata') AND NULLIF(json_extract(sm.selection_json,'$.metadata.systemId'),'') IS NOT NULL ORDER BY CASE sm.kind WHEN 'rom' THEN 0 ELSE 1 END LIMIT 1),s.system_id)`;
export const sourceMatchColumns = `
  (SELECT json_extract(sm.selection_json,'$.title') FROM source_match_selections sm WHERE sm.source_id=s.id AND sm.kind='metadata') AS matched_title,
  ${sourceSystemSql} AS matched_system_id,
  EXISTS(SELECT 1 FROM source_match_selections sm WHERE sm.source_id=s.id AND sm.kind='artwork' AND sm.artwork_role='front' AND sm.content IS NOT NULL) AS saved_artwork`;

export function sourceMatches(db: DatabaseSync, sourceId: string): SourceMatchState {
  const row = db
    .prepare('SELECT revision FROM source_match_state WHERE source_id=?')
    .get(sourceId) as { revision: number } | undefined;
  const matches = db
    .prepare(
      'SELECT selection_json,artwork_role FROM source_match_selections WHERE source_id=? ORDER BY kind,artwork_role',
    )
    .all(sourceId) as { selection_json: string; artwork_role: string }[];
  return {
    sourceId,
    revision: row?.revision ?? 0,
    matches: matches.map((match) => {
      const selection = JSON.parse(match.selection_json) as SourceMatchRecord;
      return selection.kind === 'artwork'
        ? { ...selection, artworkRole: match.artwork_role as SourceArtworkRole }
        : selection;
    }),
  };
}

/** Caller owns the transaction, change event, and authorization. */
export function writeSourceMatch(
  db: DatabaseSync,
  sourceId: string,
  expectedRevision: number,
  kind: string,
  match: SourceMatchRecord | null,
  content: Uint8Array | null,
  artworkRole?: string,
): SourceMatchState {
  const current = sourceMatches(db, sourceId);
  if (kind !== 'artwork' && artworkRole !== undefined)
    throw new DomainError('invalid-request', 400, 'Artwork role is only valid for artwork matches');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new DomainError('invalid-request', 400, 'Invalid matching revision');
  if (expectedRevision !== current.revision)
    throw new DomainError(
      'matching-conflict',
      409,
      'Saved matches changed. Refresh before replacing a selection.',
    );
  if (!['rom', 'metadata', 'artwork', 'patch', 'cheats'].includes(kind))
    throw new DomainError('invalid-request', 400, 'Invalid match category');
  const role =
    kind === 'artwork'
      ? match
        ? (match.artworkRole ?? match.metadata.artworkRole ?? 'front')
        : (artworkRole ?? 'front')
      : '';
  if (kind === 'artwork' && !ARTWORK_ROLES.includes(role as SourceArtworkRole))
    throw new DomainError('invalid-request', 400, 'Invalid artwork role');
  if (
    match &&
    current.matches.some(
      (saved) =>
        saved.id === match.id &&
        saved.kind === kind &&
        (kind !== 'artwork' || (saved.artworkRole ?? 'front') === role),
    )
  )
    return current;
  const contentLimit = kind === 'artwork' && role === 'manual' ? 8 * 1024 * 1024 : 2 * 1024 * 1024;
  if (content && content.byteLength > contentLimit)
    throw new DomainError('matching-file-too-large', 413, 'Selected content is too large');
  if (match) {
    const selection =
      kind === 'artwork' ? { ...match, artworkRole: role as SourceArtworkRole } : match;
    db.prepare(
      `INSERT INTO source_match_selections(source_id,kind,artwork_role,selection_json,content)
       VALUES(?,?,?,?,?) ON CONFLICT(source_id,kind,artwork_role) DO UPDATE SET
       selection_json=excluded.selection_json,content=excluded.content`,
    ).run(sourceId, kind, role, JSON.stringify(selection), content);
  } else {
    db.prepare(
      'DELETE FROM source_match_selections WHERE source_id=? AND kind=? AND artwork_role=?',
    ).run(sourceId, kind, role);
  }
  db.prepare(
    `INSERT INTO source_match_state(source_id,revision) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision`,
  ).run(sourceId, current.revision + 1);
  return sourceMatches(db, sourceId);
}
export function sourceMatchContent(
  db: DatabaseSync,
  sourceId: string,
  kind: string,
  artworkRole: SourceArtworkRole = 'front',
): Uint8Array | null {
  const role = kind === 'artwork' ? artworkRole : '';
  const row = db
    .prepare(
      'SELECT content FROM source_match_selections WHERE source_id=? AND kind=? AND artwork_role=?',
    )
    .get(sourceId, kind, role) as { content: Uint8Array | null } | undefined;
  return row?.content ?? null;
}

export function matchingIdentification(
  db: DatabaseSync,
  sourceId: string,
  stamp: string,
): unknown | null {
  const row = db
    .prepare('SELECT facts_json FROM source_identifications WHERE source_id=? AND stamp=?')
    .get(sourceId, stamp) as { facts_json: string } | undefined;
  return row ? (JSON.parse(row.facts_json) as unknown) : null;
}

export function saveMatchingIdentification(
  db: DatabaseSync,
  sourceId: string,
  stamp: string,
  facts: unknown,
): void {
  let factsJson: string | undefined;
  try {
    factsJson = JSON.stringify(facts);
  } catch {
    throw new DomainError('invalid-request', 400, 'Invalid matching identification');
  }
  if (factsJson === undefined || Buffer.byteLength(factsJson, 'utf8') > 256 * 1024)
    throw new DomainError('invalid-request', 400, 'Matching identification exceeds limit');
  db.prepare(
    `INSERT INTO source_identifications(source_id,stamp,facts_json) VALUES(?,?,?)
     ON CONFLICT(source_id) DO UPDATE SET stamp=excluded.stamp,facts_json=excluded.facts_json`,
  ).run(sourceId, stamp, factsJson);
}
