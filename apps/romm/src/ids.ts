import { DatabaseSync } from 'node:sqlite';
import { GatewayError } from './upstream.js';

export interface IndexEntry {
  id: number;
  kind: 'source' | 'item';
  ecsId: string;
  system: string;
  title: string;
  artwork: number;
}

/** The index stores public-to-ECS ID mappings. It never grants access to an ECS resource. */
export class IdIndex {
  private readonly database: DatabaseSync;

  constructor(path: string, origin: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS origin (key INTEGER PRIMARY KEY CHECK (key = 1), url TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ids (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('item', 'source')),
        ecsId TEXT NOT NULL,
        system TEXT NOT NULL,
        title TEXT NOT NULL,
        artwork INTEGER NOT NULL,
        UNIQUE (kind, ecsId)
      );
    `);
    this.database.prepare('INSERT OR IGNORE INTO origin VALUES (1, ?)').run(origin);
    if (this.database.prepare('SELECT url FROM origin').get()?.url !== origin) {
      this.close();
      throw new Error('This gateway index belongs to a different ECS origin.');
    }
  }

  assign(entry: Omit<IndexEntry, 'id'>): IndexEntry {
    const row = this.database
      .prepare(`
      INSERT INTO ids (kind, ecsId, system, title, artwork) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (kind, ecsId) DO UPDATE SET system = excluded.system,
        title = excluded.title, artwork = excluded.artwork
      RETURNING id
    `)
      .get(entry.kind, entry.ecsId, entry.system, entry.title, entry.artwork);
    return { ...entry, id: Number(row?.id) };
  }

  find(id: number): IndexEntry {
    const row = this.database.prepare('SELECT * FROM ids WHERE id = ?').get(id);
    if (!row) throw new GatewayError(404, 'ROM not found.');
    return row as unknown as IndexEntry;
  }

  close(): void {
    this.database.close();
  }
}
