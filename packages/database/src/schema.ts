import { DomainError } from '@ecs/domain';

export interface Migration {
  version: number;
  sql: string;
}

const INITIAL_SQL = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE server_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  bootstrapped_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE bootstrap_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_owner INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE TABLE libraries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE memberships (
  library_id TEXT NOT NULL REFERENCES libraries(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'reader')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (library_id, user_id)
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL REFERENCES libraries(id),
  system_identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  md5 TEXT,
  crc TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE blobs (
  sha256 TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  md5 TEXT,
  crc TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id),
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  size INTEGER NOT NULL,
  md5 TEXT,
  crc TEXT,
  shareable INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE guest_grants (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  library_id TEXT NOT NULL REFERENCES libraries(id),
  item_id TEXT REFERENCES items(id),
  capabilities_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  guest_grant_id TEXT REFERENCES guest_grants(id),
  library_id TEXT REFERENCES libraries(id),
  received INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  asset_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (user_id IS NOT NULL OR guest_grant_id IS NOT NULL)
);

CREATE TABLE item_acl (
  item_id TEXT NOT NULL REFERENCES items(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  permission TEXT NOT NULL CHECK (permission IN ('read', 'write', 'admin')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, user_id, permission)
);

CREATE TABLE change_log (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL,
  library_id TEXT,
  item_id TEXT,
  sensitive INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL
);

CREATE INDEX change_log_library_cursor ON change_log(library_id, cursor);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  detail_json TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  actor_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_key, idempotency_key)
);
`;

const CONTENT_ROOTS_SQL = `
CREATE TABLE content_roots (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  library_id TEXT REFERENCES libraries(id),
  created_at TEXT NOT NULL
);
`;

const CHANGE_DEVICE_SQL = `
ALTER TABLE change_log ADD COLUMN device_id TEXT;
`;

const ASSET_CONFLICT_SQL = `
ALTER TABLE assets ADD COLUMN conflict_of TEXT REFERENCES assets(id);
`;

const ACCESS_POLICY_SQL = `
ALTER TABLE server_state ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'lan';
ALTER TABLE server_state ADD COLUMN access_subnets TEXT NOT NULL DEFAULT '[]';
`;

const SOURCE_FILES_SQL = `
CREATE TABLE source_files (
  id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL REFERENCES content_roots(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  blocks INTEGER NOT NULL,
  kind TEXT NOT NULL,
  system_id TEXT,
  availability TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  UNIQUE (root_id, relative_path)
);
`;

const STORAGE_LOCATIONS_SQL = `
CREATE TABLE storage_locations (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

ALTER TABLE blobs ADD COLUMN location_id TEXT REFERENCES storage_locations(id);
ALTER TABLE server_state ADD COLUMN write_location_id TEXT REFERENCES storage_locations(id);
`;

const WEBDAV_CREDENTIALS_SQL = `
CREATE TABLE webdav_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  ha1_md5 TEXT NOT NULL,
  ha1_sha256 TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX webdav_credentials_user ON webdav_credentials(user_id);
`;

const LIBRARY_BROWSE_SQL = `
ALTER TABLE content_roots ADD COLUMN last_checked_at TEXT;
ALTER TABLE content_roots ADD COLUMN availability TEXT NOT NULL DEFAULT 'unknown' CHECK (availability IN ('unknown','online','offline'));
ALTER TABLE content_roots ADD COLUMN medium TEXT;
ALTER TABLE content_roots ADD COLUMN scan_state TEXT NOT NULL DEFAULT 'unknown' CHECK (scan_state IN ('unknown','pending','completed','failed'));
ALTER TABLE content_roots ADD COLUMN last_scan_started_at TEXT;
ALTER TABLE content_roots ADD COLUMN last_scan_completed_at TEXT;
ALTER TABLE content_roots ADD COLUMN scan_error TEXT;
CREATE INDEX content_roots_library ON content_roots(library_id, id);
CREATE INDEX source_files_root_kind ON source_files(root_id, kind, id);
CREATE INDEX assets_item_kind_live ON assets(item_id, kind, id) WHERE deleted_at IS NULL;
CREATE INDEX items_library_live ON items(library_id, id) WHERE deleted_at IS NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: INITIAL_SQL },
  { version: 2, sql: CONTENT_ROOTS_SQL },
  { version: 3, sql: CHANGE_DEVICE_SQL },
  { version: 4, sql: ASSET_CONFLICT_SQL },
  { version: 5, sql: ACCESS_POLICY_SQL },
  { version: 6, sql: SOURCE_FILES_SQL },
  { version: 7, sql: STORAGE_LOCATIONS_SQL },
  { version: 8, sql: WEBDAV_CREDENTIALS_SQL },
  { version: 9, sql: LIBRARY_BROWSE_SQL },
  {
    version: 10,
    sql: `
    ALTER TABLE source_files ADD COLUMN group_anchor TEXT;
    ALTER TABLE source_files ADD COLUMN group_members_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE source_files ADD COLUMN group_error TEXT;
    CREATE INDEX source_files_group ON source_files(root_id,group_anchor);
  `,
  },
  {
    version: 11,
    sql: `
    CREATE TABLE source_match_state (
      source_id TEXT PRIMARY KEY REFERENCES source_files(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision >= 0)
    );
    CREATE TABLE source_match_selections (
      source_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('rom','metadata','artwork','patch','cheats')),
      selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
      content BLOB CHECK(content IS NULL OR length(content) <= 2097152),
      PRIMARY KEY(source_id,kind)
    );
  `,
  },
  {
    version: 12,
    sql: `
    ALTER TABLE source_files ADD COLUMN filesystem_identity TEXT;
    ALTER TABLE source_files ADD COLUMN mtime_ms REAL;
    CREATE INDEX source_files_identity ON source_files(root_id,filesystem_identity);
  `,
  },
  {
    version: 13,
    sql: `
    ALTER TABLE source_files ADD COLUMN missing_at TEXT;
    ALTER TABLE source_files ADD COLUMN original_relative_path TEXT;
    CREATE VIEW live_source_files AS SELECT * FROM source_files WHERE missing_at IS NULL;
    CREATE INDEX source_files_live_identity ON source_files(filesystem_identity);
  `,
  },
  {
    version: 14,
    sql: `
    CREATE TABLE source_organization_policies (
      source_root_id TEXT PRIMARY KEY REFERENCES content_roots(id) ON DELETE CASCADE,
      library_id TEXT REFERENCES libraries(id) ON DELETE CASCADE,
      target_root_id TEXT NOT NULL REFERENCES content_roots(id) ON DELETE CASCADE,
      source_root_path TEXT NOT NULL,
      target_root_path TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('copy','move')),
      enabled_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      enabled_at TEXT NOT NULL
    );
    CREATE TABLE source_organization_copies (
      source_root_id TEXT NOT NULL REFERENCES content_roots(id) ON DELETE CASCADE,
      original_source_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
      copy_source_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
      original_identity TEXT NOT NULL,
      copy_identity TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      PRIMARY KEY(source_root_id,original_source_id),
      UNIQUE(copy_source_id)
    );
  `,
  },
  {
    version: 15,
    sql: `
    CREATE TABLE folder_watch_policies (
      root_id TEXT PRIMARY KEY REFERENCES content_roots(id) ON DELETE CASCADE,
      root_path TEXT NOT NULL,
      enabled_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
  `,
  },
  {
    version: 16,
    sql: `
    CREATE TABLE library_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('scan','match')),
      scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
      options_json TEXT NOT NULL CHECK(json_valid(options_json)),
      state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','cancelled','interrupted')),
      actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      error TEXT,
      interrupted_count INTEGER NOT NULL DEFAULT 0,
      current_id TEXT,
      total INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      saved INTEGER NOT NULL DEFAULT 0,
      review INTEGER NOT NULL DEFAULT 0,
      unmatched INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX library_jobs_queue ON library_jobs(state,created_at,id);
    CREATE TABLE library_job_items (
      job_id TEXT NOT NULL REFERENCES library_jobs(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','saved','review','unmatched','failed','skipped','reviewed')),
      saved INTEGER NOT NULL DEFAULT 0,
      suggestions INTEGER NOT NULL DEFAULT 0,
      result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
      error TEXT,
      PRIMARY KEY(job_id,entity_id)
    );
    CREATE INDEX library_job_items_queue ON library_job_items(job_id,state,entity_id);
  `,
  },
  {
    version: 17,
    sql: `
    ALTER TABLE source_files ADD COLUMN match_parent TEXT NOT NULL DEFAULT '';
    ALTER TABLE source_files ADD COLUMN match_stem TEXT NOT NULL DEFAULT '';
    ALTER TABLE source_files ADD COLUMN match_extension TEXT NOT NULL DEFAULT '';
    UPDATE source_files SET match_parent=ecs_companion_parent(relative_path),
      match_stem=ecs_companion_stem(display_name), match_extension=ecs_companion_extension(display_name);
    CREATE INDEX source_files_match_stem ON source_files(root_id,match_parent,match_stem,relative_path) WHERE missing_at IS NULL;
    CREATE INDEX source_files_match_extension ON source_files(root_id,match_parent,match_extension,relative_path) WHERE missing_at IS NULL;
    `,
  },
  {
    version: 18,
    sql: `CREATE TABLE source_fingerprints (
      source_id TEXT PRIMARY KEY REFERENCES source_files(id) ON DELETE CASCADE,
      stamp TEXT NOT NULL, md5 TEXT NOT NULL CHECK(length(md5)=32),
      crc32 TEXT NOT NULL CHECK(length(crc32)=8), size INTEGER NOT NULL CHECK(size>=0)
    );`,
  },
  {
    version: 19,
    sql: `
    ALTER TABLE source_match_selections RENAME TO source_match_selections_v18;
    CREATE TABLE source_match_selections (
      source_id TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('rom','metadata','artwork','patch','cheats')),
      artwork_role TEXT NOT NULL DEFAULT '' CHECK(
        (kind='artwork' AND artwork_role IN ('front','back','disc','manual','title','screenshot','other')) OR
        (kind<>'artwork' AND artwork_role='')
      ),
      selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
      content BLOB CHECK(content IS NULL OR length(content) <= 8388608),
      PRIMARY KEY(source_id,kind,artwork_role)
    );
    INSERT INTO source_match_selections(source_id,kind,artwork_role,selection_json,content)
      SELECT source_id,kind,CASE WHEN kind='artwork' THEN 'front' ELSE '' END,selection_json,content
      FROM source_match_selections_v18;
    DROP TABLE source_match_selections_v18;
    CREATE TABLE source_identifications (
      source_id TEXT PRIMARY KEY REFERENCES source_files(id) ON DELETE CASCADE,
      stamp TEXT NOT NULL,
      facts_json TEXT NOT NULL CHECK(json_valid(facts_json) AND length(CAST(facts_json AS BLOB)) <= 262144)
    );
    UPDATE source_files SET match_stem=ecs_companion_stem(display_name);
  `,
  },
  {
    version: 20,
    sql: `
    ALTER TABLE library_job_items ADD COLUMN system_id TEXT;
    UPDATE library_job_items AS i SET system_id=(
      SELECT s.system_id FROM live_source_files s WHERE s.id=i.entity_id
    ) WHERE EXISTS(SELECT 1 FROM library_jobs j WHERE j.id=i.job_id AND j.kind='match');
    CREATE INDEX library_job_items_affinity ON library_job_items(job_id,state,system_id,entity_id);
  `,
  },
];

export const SCHEMA_VERSION = Math.max(...MIGRATIONS.map((entry) => entry.version));

/**
 * Selects the migrations still to run. Pass null when the ledger table does not
 * exist yet, which is the only state that counts as a new database.
 *
 * An existing ledger may only hold a contiguous prefix of the versions this build
 * knows. A gap, an empty ledger, or an unrecognized version means another build
 * wrote the file, and guessing which statements are missing would put the
 * operator's rows at risk.
 */
export function pendingMigrations(applied: ReadonlySet<number> | null): readonly Migration[] {
  if (applied === null) return MIGRATIONS;
  const prefix = MIGRATIONS.slice(0, applied.size);
  if (
    applied.size === 0 ||
    applied.size > MIGRATIONS.length ||
    prefix.some((entry) => !applied.has(entry.version))
  ) {
    throw new DomainError('migration', 500, 'Database schema version is not supported');
  }
  return MIGRATIONS.slice(applied.size);
}
