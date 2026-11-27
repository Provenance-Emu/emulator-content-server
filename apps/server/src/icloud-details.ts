/**
 * Game details and covers brought in from the Provenance app's records in iCloud.
 *
 * Fill, never override: a value this server already has stays, whoever put it there, and
 * anything a person typed or chose here is left alone. The app does not say which values its
 * owner edited, so nothing from it may replace what is known here.
 * See docs/superpowers/specs/2026-11-27-icloud-details-sync-design.md.
 */
import { createHash } from 'node:crypto';
import type { CatalogDatabase } from '@ecs/database';
import {
  DomainError,
  FRONT_ARTWORK_MAX_BYTES,
  MANUAL_PROVIDER_ID,
  PROVENANCE_PROVIDER_ID,
  type SourceMatchRecord,
} from '@ecs/domain';
import { CLOUD_DETAILS, type CloudRom } from './cloudkit.js';
import { imageType } from './matching-files.js';

const COVER_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
export const COVER_MAX_BYTES = FRONT_ARTWORK_MAX_BYTES;

/** What the app's record would add to a game here. Nothing in it replaces a value. */
export interface DetailsPlan {
  /** The details record to save, or null when there is nothing to add. */
  record: SourceMatchRecord | null;
  /** True when the app's own cover may take the front cover's place. */
  wantsCover: boolean;
}

/**
 * Works out what one game record adds to one scanned file, from the file's saved records.
 * Pure: reads nothing and writes nothing.
 */
export function planDetails(
  rom: CloudRom,
  matches: SourceMatchRecord[],
  fallbackTitle: string,
  now = new Date().toISOString(),
): DetailsPlan {
  const current = matches.find((match) => match.kind === 'metadata');
  const front = matches.find(
    (match) => match.kind === 'artwork' && (match.artworkRole ?? 'front') === 'front',
  );
  // The app's cover only goes where there is no cover. A cover already here may be one the
  // owner picked from a provider, which is saved the same way as one found automatically, and
  // putting another in its place would lose it with no way back.
  const wantsCover = rom.hasCustomCover === true && !front;
  const offered = Object.fromEntries(
    CLOUD_DETAILS.flatMap((key) => {
      const value = clean(rom.details?.[key], key === 'description' ? 2000 : 200);
      if (!value || (key === 'year' && !/^\d{4}$/.test(value))) return [];
      return [[key, value]];
    }),
  );
  if (current?.providerId === MANUAL_PROVIDER_ID) return { record: null, wantsCover };
  if (!current) {
    // A record here stops the server looking the game up itself. That is a fair trade for real
    // details, and a poor one for a title alone, so a game the app knows only by name is left
    // for matching to find.
    if (Object.keys(offered).length === 0) return { record: null, wantsCover };
    const title = clean(rom.title, 200) || fallbackTitle;
    const metadata: Record<string, string> = { title, ...offered };
    return {
      record: {
        id: `${PROVENANCE_PROVIDER_ID}:metadata:${createHash('sha256')
          .update(JSON.stringify([title, offered]))
          .digest('hex')
          .slice(0, 32)}`,
        providerId: PROVENANCE_PROVIDER_ID,
        kind: 'metadata',
        title,
        confidence: 'local',
        metadata,
        originKind: null,
        contentAvailable: false,
        contentType: null,
        fileName: null,
        updatedAt: now,
      },
      wantsCover,
    };
  }
  // A record is here already: only its empty fields are filled, and its title is left alone.
  const added = Object.entries(offered).filter(([key]) => !current.metadata[key]?.trim());
  if (added.length === 0) return { record: null, wantsCover };
  const metadata = { ...current.metadata, ...Object.fromEntries(added) };
  // Saving under the identifier already in place changes nothing, so the filled record gets
  // its own: the one it grew from, and a mark for what was added.
  const base = current.id.split('~filled-')[0];
  const mark = createHash('sha256').update(JSON.stringify(metadata)).digest('hex').slice(0, 16);
  return {
    record: { ...current, id: `${base}~filled-${mark}`, metadata, updatedAt: now },
    wantsCover,
  };
}

/** The record a cover from the app is saved as, or null when the bytes are not a usable image. */
export function coverRecord(
  bytes: Buffer,
  title: string,
  now = new Date().toISOString(),
): SourceMatchRecord | null {
  if (bytes.length === 0 || bytes.length > COVER_MAX_BYTES) return null;
  const type = imageType(bytes);
  const extension = type ? COVER_EXTENSIONS[type] : undefined;
  if (!type || !extension) return null;
  return {
    id: `${PROVENANCE_PROVIDER_ID}:artwork:${createHash('sha256').update(bytes).digest('hex')}`,
    providerId: PROVENANCE_PROVIDER_ID,
    kind: 'artwork',
    artworkRole: 'front',
    title,
    confidence: 'local',
    metadata: { artworkRole: 'front' },
    originKind: null,
    contentAvailable: true,
    contentType: type,
    fileName: `cover.${extension}`,
    updatedAt: now,
  };
}

/**
 * Saves a record with the revision it was planned against. False when the file changed in the
 * meantime: whoever changed it wins, and the game is looked at again next time.
 */
export function saveIfUnchanged(
  catalog: CatalogDatabase,
  sourceId: string,
  revision: number,
  record: SourceMatchRecord,
  content: Uint8Array | null,
  actorId: string,
): boolean {
  try {
    catalog.saveSourceMatch(
      sourceId,
      revision,
      record.kind,
      record,
      content,
      actorId,
      record.kind === 'artwork' ? 'front' : undefined,
    );
    return true;
  } catch (error) {
    if (error instanceof DomainError && (error.status === 409 || error.status === 412))
      return false;
    throw error;
  }
}

/** Text as a person would have typed it: no control characters, trimmed, cut at whole characters. */
function clean(value: string | null | undefined, max: number): string {
  if (!value) return '';
  const plain = [...value]
    .filter((character) => (character.codePointAt(0) ?? 0) >= 32 && character !== '\u007f')
    .join('')
    .trim();
  return [...plain].slice(0, max).join('').trim();
}
