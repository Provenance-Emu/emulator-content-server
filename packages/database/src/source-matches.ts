import type { DatabaseSync } from 'node:sqlite';
import { DomainError, type SourceMatchRecord, type SourceMatchState } from '@ecs/domain';

export const sourceTitleSql = `COALESCE((SELECT json_extract(sm.selection_json,'$.title') FROM source_match_selections sm WHERE sm.source_id=s.id AND sm.kind='metadata'),s.display_name)`;
export const sourceSystemSql = `COALESCE((SELECT NULLIF(json_extract(sm.selection_json,'$.metadata.systemId'),'') FROM source_match_selections sm WHERE sm.source_id=s.id AND sm.kind IN ('rom','metadata') AND NULLIF(json_extract(sm.selection_json,'$.metadata.systemId'),'') IS NOT NULL ORDER BY CASE sm.kind WHEN 'rom' THEN 0 ELSE 1 END LIMIT 1),s.system_id)`;
export const sourceMatchColumns = `
  (SELECT json_extract(sm.selection_json,'$.title') FROM source_match_selections sm WHERE sm.source_id=s.id AND sm.kind='metadata') AS matched_title,
  ${sourceSystemSql} AS matched_system_id,
  EXISTS(SELECT 1 FROM source_match_selections sm WHERE sm.source_id=s.id AND sm.kind='artwork' AND sm.content IS NOT NULL) AS saved_artwork`;

export function sourceMatches(db: DatabaseSync, sourceId: string): SourceMatchState {
  const row = db
    .prepare('SELECT revision FROM source_match_state WHERE source_id=?')
    .get(sourceId) as { revision: number } | undefined;
  const matches = db
    .prepare('SELECT selection_json FROM source_match_selections WHERE source_id=? ORDER BY kind')
    .all(sourceId) as { selection_json: string }[];
  return {
    sourceId,
    revision: row?.revision ?? 0,
    matches: matches.map((match) => JSON.parse(match.selection_json) as SourceMatchRecord),
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
): SourceMatchState {
  const current = sourceMatches(db, sourceId);
  if (match && current.matches.some((saved) => saved.id === match.id && saved.kind === kind))
    return current;
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
  if (content && content.byteLength > 2 * 1024 * 1024)
    throw new DomainError('matching-file-too-large', 413, 'Selected content is too large');
  if (match)
    db.prepare(
      `INSERT INTO source_match_selections(source_id,kind,selection_json,content) VALUES(?,?,?,?) ON CONFLICT(source_id,kind) DO UPDATE SET selection_json=excluded.selection_json,content=excluded.content`,
    ).run(sourceId, kind, JSON.stringify(match), content);
  else
    db.prepare('DELETE FROM source_match_selections WHERE source_id=? AND kind=?').run(
      sourceId,
      kind,
    );
  db.prepare(
    `INSERT INTO source_match_state(source_id,revision) VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision`,
  ).run(sourceId, current.revision + 1);
  return sourceMatches(db, sourceId);
}
export function sourceMatchContent(
  db: DatabaseSync,
  sourceId: string,
  kind: string,
): Uint8Array | null {
  const row = db
    .prepare('SELECT content FROM source_match_selections WHERE source_id=? AND kind=?')
    .get(sourceId, kind) as { content: Uint8Array | null } | undefined;
  return row?.content ?? null;
}
