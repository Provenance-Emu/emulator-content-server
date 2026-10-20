# WebDAV compatibility

An authenticated read-only WebDAV facade is implemented at `/dav/` for Finder,
rclone, and Cyberduck. The canonical app API remains `/api/v1`.

## Status

Merged in #13. Enable it with `ecs serve --webdav` or `ECS_WEBDAV=1`; disabled
processes report `features.webdav: false`. Account sessions issue and revoke
Digest app credentials; existing bearer credentials can read with their existing
ACLs. DAV does not use tokenless loopback/LAN access. It exposes catalog assets
and scanned sources, with bounded PROPFIND, conditional/ranged reads, path
containment, guest BIOS/system filtering, and offline/placeholder handling.

See [WebDAV operations](../webdav.md) for setup, credential lifecycle, proxy
requirements, limits, and client instructions. Automated coverage includes an
independent curl Digest client, Finder-style protocol sequences, and REST range
parity. A native Finder mount has not been established by those protocol tests;
manual native-client acceptance remains separate work.

## Owned paths

- `apps/server` WebDAV routes, authentication, and credential management
- `packages/auth` Digest helpers and `packages/database` credential persistence
- `packages/client-ts` and `clients/swift` generated credential operations
- contract capability flag `features.webdav`
- tests

## Behavior

- Require a bearer or Digest credential tied to the same ACL evaluator. The
  facade is read-only; no credential permits DAV writes.
- Honor single `Range` on GET, including 206 and 416. A whole-file GET must not be the only read path.
- Reject symlink and lexical escape with the storage path helper.
- Keep BIOS and system files hidden from guest credentials.

## Acceptance

- A contract test fetches a middle byte range and compares it to the REST content route.
- An unauthenticated PROPFIND is rejected.
- The capability document reports `webdav: true` only when the facade is enabled.

## Non-goals

Replacing the JSON API, adding DAV writes or locks, or serving the data directory
as the process root.
