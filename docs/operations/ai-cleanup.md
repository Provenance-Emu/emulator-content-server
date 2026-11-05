# Native library cleanup

Library activity offers **Review library cleanup** to owners. Inspection creates
findings and proposed changes. Select exact proposal versions, approve the batch,
then apply it. Saved metadata and front-cover selections change per source in one
transaction. Original game files stay in place. Undo is conditional on the saved
selection still matching the application receipt and expires after 30 days.

## Run the native host

Use Node 22.22.2 and the matching `ecs-plugins` build. Provision a workflow host
from an authenticated owner session using `POST /api/v1/workflow-hosts`. Enroll
its one-time token through `POST /api/v1/workflow-workers/enroll`. Save the returned
service token in an owner-only file, outside the host-state directory. Host
credentials authorize assigned workflow operations. The owner session supplies
approval and application authority.

```sh
ecs-plugins workflows install-defaults --state /absolute/private-host
ecs-plugins workflows serve --state /absolute/private-host \
  --server http://127.0.0.1:8473 \
  --credential-file /absolute/private/workflow-token
```

The state directory requires owner-only permissions. Use HTTPS for a remote
server. Requests have a 15-second deadline, including response-body reads, and
abort during host shutdown. The built-in workflow supports deterministic no-key
inspection. Installed packages execute as trusted native code in separate
processes. Activate only packages whose code the operator trusts.

Package versions are content-addressed. Activation affects subsequent resolutions
while granted historical pins remain available to existing runs. Disabling a
package stops further resolution. Confirmed operation results can be reused
without resolving a revoked backend, with immutable step-input checks retained.

## Artifact retention

Collection runs in bounded transactions at startup, hourly and when staging new
artwork. Each phase handles at most 100 records per pass.

- Pending proposal artwork remains referenced until an owner explicitly keeps or
  dismisses the finding. Age alone does not end review.
- After a terminal run and 30 days of grace, abandoned staging and explicitly
  dismissed proposal references become eligible. Existing approval references
  conservatively preserve their proposal bytes.
- Selected artwork remains referenced while selected. Changing the front cover
  through ordinary owner controls releases that selection reference.
- Undo references, prior-selection blobs and before-state payloads expire after
  the receipt's 30-day deadline. Application receipts remain available.
- Artwork with no references becomes collectible after 30 days. Collection and
  reference commits share SQLite's write transaction lock.

Existing per-run, per-library and server staging quotas remain enforced. If review
material fills the quota, finish or dismiss that review and allow its grace period
to expire. Review and application receipts are retained for audit and idempotency.

## Coordinated backup and restore

Stop both the ECS server and workflow host before taking the two snapshots. Keep
both stopped until both commands complete, so catalog and private history share
one quiescent boundary. Preserve source-library paths and storage mappings using
the existing server backup procedure.

```sh
ecs backup --data /absolute/content-data --to /absolute/backup/server
ecs-plugins workflows backup --state /absolute/private-host \
  --to /absolute/backup/host
```

Host export requires a new destination. It takes the serving lock and the shared
package-mutation lock. SQLite's backup export retains operation handles, results,
leases and publication intents. Exact installed packages, activation pointers and
historical grants are copied with a versioned size/SHA-256 manifest. Credential
files and arbitrary extra files are excluded. Destinations are private, with
limits of 10,000 files and 1 GiB. Treat backups as trusted private executable and
operation-state data.

Restore the server backup through the existing stopped-server restore procedure.
Restore the host into a new private directory.

```sh
ecs-plugins workflows restore --from /absolute/backup/host \
  --state /absolute/restored-private-host
ecs-plugins workflows recovery --state /absolute/restored-private-host
```

Restore validates every manifest file and rejects missing, changed, oversized or
linked files. Interrupted snapshots without a complete manifest fail validation.
An existing destination is preserved. Failed new restores are removed.

Every restored unfinished run is marked recovery-required, including coordinated
restores. This is conservative because an external operation may have completed
after the backup. Starting a host preserves that state and reports recovery to
the server. Reprovision its credential file separately. Owners should reconcile
external outcomes and saved receipts, cancel uncertain old runs, then explicitly
start a fresh inspection when appropriate. Confirmed history remains in the
restored database for investigation.

For ordinary restarts, the server returns its publication sequence/checkpoint in
the lease. The host checks those against acknowledged or pending local history.
A durable dispatch intent is acknowledged by the server before a backend starts.
A missing/stale/partial host snapshot, divergent server history or uncertain
submission therefore requires recovery. Whole-system historical restores use the
restore command to set the conservative marker. Raw manual database replacement
can remove that marker and is outside the supported restore procedure.

Built-in model/provider connections and the separate inbound MCP adapter remain
tracked independently. The external-assistant adapter is issue #27.
