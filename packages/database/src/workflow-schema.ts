export const WORKFLOW_SQL = `
CREATE TABLE workflow_hosts (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, enrollment_hash TEXT UNIQUE, enrollment_expires INTEGER,
 packages_json TEXT NOT NULL DEFAULT '[]', last_seen_at TEXT,
 token_hash TEXT UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE workflow_runs (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, workflow_digest TEXT NOT NULL,
 host_id TEXT NOT NULL REFERENCES workflow_hosts(id), actor_id TEXT NOT NULL REFERENCES users(id),
 scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), options_json TEXT NOT NULL CHECK(json_valid(options_json)),
 state TEXT NOT NULL CHECK(state IN ('queued','running','interrupted','completed','cancelled','failed','recovery-required')),
 revision INTEGER NOT NULL DEFAULT 1, total INTEGER NOT NULL DEFAULT 0, processed INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
 fence INTEGER NOT NULL DEFAULT 0, lease_expires INTEGER, publication_sequence INTEGER NOT NULL DEFAULT 0, checkpoint_ref TEXT
);
CREATE INDEX workflow_runs_queue ON workflow_runs(host_id,state,created_at,id);
CREATE TABLE workflow_run_requests (
 actor_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
 request_digest TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 PRIMARY KEY(actor_id,request_key)
);
CREATE TABLE workflow_work (
 run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE, source_id TEXT NOT NULL,
 index_validator TEXT NOT NULL, selection_revision INTEGER NOT NULL, library_id TEXT,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed')), output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)), PRIMARY KEY(run_id,source_id)
);
CREATE INDEX workflow_work_page ON workflow_work(run_id,state,source_id);
CREATE TABLE workflow_publications (
 run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
 fence INTEGER NOT NULL, digest TEXT NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json)), PRIMARY KEY(run_id,sequence)
);
CREATE TABLE workflow_findings (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 source_id TEXT NOT NULL, fingerprint TEXT NOT NULL, finding_json TEXT NOT NULL CHECK(json_valid(finding_json)), UNIQUE(run_id,fingerprint)
);
CREATE INDEX workflow_findings_page ON workflow_findings(run_id,id);
CREATE TABLE workflow_decisions (
 fingerprint TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), decision TEXT NOT NULL CHECK(decision IN ('keep','dismiss')),
 created_at TEXT NOT NULL, PRIMARY KEY(fingerprint,actor_id)
);
CREATE TABLE workflow_evidence (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE, source_id TEXT NOT NULL,
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json))
);
CREATE INDEX workflow_evidence_run ON workflow_evidence(run_id,source_id,id);
CREATE TABLE workflow_proposals (
 id TEXT NOT NULL, version INTEGER NOT NULL, run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
 source_id TEXT NOT NULL, finding_id TEXT NOT NULL REFERENCES workflow_findings(id),
 proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)), digest TEXT NOT NULL,
 PRIMARY KEY(id,version)
);
CREATE INDEX workflow_proposals_page ON workflow_proposals(run_id,id,version);
CREATE TABLE workflow_artifacts (
 id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, content BLOB NOT NULL CHECK(length(content)<=2097152),
 description_json TEXT NOT NULL CHECK(json_valid(description_json)), created_at TEXT NOT NULL, expires_at TEXT
);
CREATE TABLE workflow_artifact_refs (
 artifact_id TEXT NOT NULL REFERENCES workflow_artifacts(id), run_id TEXT NOT NULL REFERENCES workflow_runs(id),
 source_id TEXT NOT NULL, reference_kind TEXT NOT NULL CHECK(reference_kind IN ('proposal','selected','undo')),
 reference_id TEXT NOT NULL, PRIMARY KEY(artifact_id,reference_kind,reference_id)
);
CREATE TABLE workflow_approvals (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workflow_runs(id), actor_id TEXT NOT NULL REFERENCES users(id),
 approval_json TEXT NOT NULL CHECK(json_valid(approval_json)), request_key TEXT NOT NULL, digest TEXT NOT NULL,
 UNIQUE(actor_id,request_key)
);
CREATE TABLE workflow_application_batches (
 id TEXT PRIMARY KEY, approval_id TEXT NOT NULL REFERENCES workflow_approvals(id), actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX workflow_approvals_run ON workflow_approvals(run_id,id);
CREATE INDEX workflow_batches_approval ON workflow_application_batches(approval_id,created_at,id);
CREATE TABLE workflow_applications (
 id TEXT NOT NULL, source_id TEXT NOT NULL, approval_id TEXT NOT NULL REFERENCES workflow_approvals(id),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), before_json TEXT NOT NULL CHECK(json_valid(before_json)),
 post_digest TEXT NOT NULL, undo_expires_at TEXT NOT NULL, PRIMARY KEY(id,source_id), FOREIGN KEY(id) REFERENCES workflow_application_batches(id)
);
CREATE TABLE workflow_undo_blobs (
 application_id TEXT NOT NULL, source_id TEXT NOT NULL, kind TEXT NOT NULL, artwork_role TEXT NOT NULL,
 content BLOB NOT NULL, PRIMARY KEY(application_id,source_id,kind,artwork_role),
 FOREIGN KEY(application_id,source_id) REFERENCES workflow_applications(id,source_id) ON DELETE CASCADE
);
CREATE INDEX workflow_applications_approval ON workflow_applications(approval_id,id,source_id);
CREATE TABLE workflow_access_tokens (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
 grant_json TEXT NOT NULL CHECK(json_valid(grant_json)), expires_at TEXT NOT NULL, revoked_at TEXT
);
`;
