# Storage locations

Let the content-addressed store span more than one directory so blobs can live on an external drive or a NAS mount. Addressing, ranges, and the ACL evaluator do not change.

## Owned paths

- `packages/database` migration and location repository
- `packages/storage` location resolution and blob placement
- `apps/server` wiring
- `apps/cli` `locations` command, `doctor`, `backup`
- tests and `docs/operations`

## Behavior

- The data directory stays the primary location and is always present. Additional locations are registered with a label and hold the same `blobs/sha256/<2-hex>/<64-hex>` layout.
- A blob lives in exactly one location and the catalog records which. A read resolves the location, then the path. The address is still the SHA-256, so the same bytes keep the same name everywhere.
- A write picks a location from explicit configuration, never from free space, so an operator can predict where bytes land.
- Staging uploads and the virtual cache stay in the primary data directory. A half-finished upload must not land on a removable drive, and a cache blob must be reproducible without it.
- An absent location is offline, not corrupt. Reads of its blobs fail with a distinct error rather than a 404, and `doctor` reports offline separately from a missing blob.
- `doctor` verifies every online location. `backup` either covers all locations or refuses with a message naming what it would miss.
- Removing a location is refused while the catalog still references a blob in it.
- Requires the ordered migration runner. The catalog must open twice and keep existing rows.

## Acceptance

- A blob written to a secondary location is readable as a byte range through the content route, identical to one in the primary.
- Taking a location offline produces an offline report and a distinct read error, and leaves the primary unaffected.
- Removing a referenced location is refused.
- `backup` covers every location or fails loudly, and never writes a partial archive silently.
- An existing single-directory database keeps working with no location rows added.

## Status

Registered directories, an explicit write target, offline reads, and backup refusal are implemented. `ecs locations` is the operator interface. The content routes are unchanged, and the web UI does not manage locations yet.

## Non-goals

Replication, tiering by access frequency, automatic rebalancing between locations, RAID, and cloud object storage.
