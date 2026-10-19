# Authenticated WebDAV compatibility

## Intent and agreed scope

Add a read-only WebDAV facade for browsing and downloading the content server's
catalog from Finder, rclone, and Cyberduck. The user selected Finder-compatible
Digest credentials in addition to existing bearer tokens. `/api/v1` remains the
canonical API and the only upload/write interface in this change.

Work starts from `935d267`, after tray controls and storage-location management.
Use branch `codex/webdav-compatibility` in its own worktree. Commit and push, open
one PR, fix CI failures, and merge after checks pass. Leave local `main` untouched.

## Approach and alternatives

Implement a protocol package with an injected catalog/content adapter. Mount it
inside the existing server under `/dav/`, using the same listener and exposure
policy. This keeps SQLite and physical-path resolution in the server and storage
packages, while DAV handles paths, XML properties, and HTTP method semantics.

A bearer-only facade is smaller but does not address the user's selected Finder
scope. Exposing a physical directory through a generic DAV server would bypass
catalog ACLs and expose internal files. Neither is the selected approach.

Keep account passwords in their existing Argon2 form. Do not derive Digest
credentials from bearer-token hashes or change account password hashing. Issue
separate random app passwords with dedicated Digest verifiers instead.

## Enablement and package boundaries

- WebDAV is off by default. `ecs serve --webdav` or `ECS_WEBDAV=1` enables it.
  Persist `--webdav` in a per-user service registration when the operator selects
  it during service installation. Existing registrations retain their settings.
- Add `webdavEnabled` to server options/context. `/api/v1/capabilities` reports
  `features.webdav: true` only for an enabled mount; disabled servers do not mount
  DAV routes. Existing public-bind/TLS requirements remain in force.
- New `@ecs/webdav` may depend on domain and protocol types/utilities. It must not
  import SQLite, the server, or storage implementations. Its adapter resolves
  authorized resources and supplies metadata/readers, rather than physical paths.
- Digest parsing, challenge generation, and verification belong in `@ecs/auth`;
  verifier persistence belongs in `@ecs/database`. Server composition owns their
  integration. Update workspace/build/boundary declarations for the new package.
- Keep the web UI and tray unchanged. Credential management is available through
  the JSON API and generated TypeScript client; document the setup flow.

## Authentication and credential lifecycle

Every DAV request, including OPTIONS and PROPFIND, needs a valid bearer token or
Digest credential. Loopback/LAN admission never authenticates a DAV request. DAV
authentication must occur before namespace lookup or XML parsing, including on
requests carrying tray-origin headers. Digest is accepted only under `/dav/`.

Add authenticated account-session endpoints:

- `POST /api/v1/webdav-credentials`: create a credential for the current user from
  a trimmed 1–80 character label and optional lifetime of 60 seconds to 365 days
  (default 90 days). Allow at most 32 active credentials per account. Return
  metadata, a generated login name, and a
  cryptographically random 32-byte app password once. Send `Cache-Control:
  no-store`. Credential creation has no secret-bearing idempotency cache.
- `GET /api/v1/webdav-credentials`: list the current user's metadata, including
  expiry/revocation status; never return passwords or Digest verifiers.
- `DELETE /api/v1/webdav-credentials/{id}`: revoke the current user's credential.

Management requires a real, unexpired session bearer token, not a trusted socket,
guest, device token, or Digest credential. Credentials are read-only and tied to
the issuing user's live account and ACLs. They cannot manage accounts or mint
credentials. Membership/grant changes apply on the next request. Password reset
revokes that account's DAV credentials; logout does not implicitly revoke app
credentials. Disabled DAV mounts cannot issue new DAV credentials, but existing
credential metadata and revocation remain available to account sessions.

Add migration 8 for credential metadata and MD5/SHA-256 HA1 verifiers. Do not
change migrations 1–7. Store no plaintext app password. Verifiers are sensitive
authentication material and stay out of API lists, audit details, logs, and
generated fixtures. Record creation/revocation audit events using IDs and labels.

Use a fixed realm, `Emulator Content Server WebDAV`, and `qop=auth`. Advertise
SHA-256 first and MD5 for legacy-client compatibility. Both use the random app
password, never a human account password. Validate algorithm, realm, nonce,
opaque, URI, method, client nonce, eight-digit positive nonce count, response
length, duplicate fields, and header size. Compare responses in constant time.

Use five-minute server-authenticated nonces bound to this process, and a replay
cache keyed by credential/server nonce/client nonce that rejects repeated counts.
Retain a 64-count sliding window to permit distinct out-of-order counts without
falsely rejecting concurrent client requests. Expire entries with their nonce;
limit the cache to 10,000 entries and refuse new authenticated nonce contexts with
503 when full rather than evicting live replay protection. Expired valid nonces
return a fresh challenge
with `stale=true`; invalid credentials do not. Restart invalidates old nonces.
Rate-limit failed authentication by socket address without logging credentials.
Do not apply the login request quota to successful DAV reads. Expiry and
revocation are checked on every authenticated request.

## Virtual namespace and authorization

Expose a virtual namespace with two root collections:

- `/dav/libraries/`: accessible libraries, their accessible items, and stored
  assets. Directory components use stable IDs; display names are DAV properties.
  Files combine stable asset IDs with sanitized display names, preserving file
  extensions and preventing duplicate-name collisions.
- `/dav/sources/`: accessible registered content roots and their scanned source
  files, arranged using validated relative paths. Display names and availability
  are metadata; absolute source/storage/data paths never appear in DAV output.

Use the existing ACL evaluator for every collection listing and direct file
lookup. Library roles, item-only grants, guest library/item bounds, read scopes,
expiry, and revocation must all remain effective. A collection must not reveal
names of resources its actor cannot read. An item-scoped guest cannot browse
unrelated items or scanned roots. DAV always hides BIOS and system-file entries
from guests, including direct URL requests; ordinary account access follows its
existing ACL. Return not-found for inaccessible resources rather than leaking
their metadata through properties or errors.

Resolve URLs as virtual segments, never as filesystem paths. Reject malformed
percent encoding, encoded separators, backslashes, NUL/control characters,
absolute/drive paths, and dot segments before lookup. Encode each href segment
and XML-escape names/properties. Names cannot produce traversal or XML markup.

Before opening physical bytes, use the storage containment helper to reject
lexical and symlink escape, including symlinks inside blob stores. Reuse the REST
content-resolution and range/ETag behavior through focused shared server helpers.
Missing/unplugged storage and evicted source placeholders retain existing REST
failure behavior; DAV listing must not hydrate or hash placeholders.

## DAV method behavior

- Authenticated OPTIONS: advertise DAV class 1 and the implemented read methods.
  Do not advertise locking or write support.
- PROPFIND: support Depth 0 and 1, empty body/allprop, propname, and explicitly
  requested properties. Return 207 XML multistatus with 200/404 property groups.
  Missing Depth is infinity per RFC 4918; reject infinity with the finite-depth
  DAV error rather than recursively walking the catalog. Invalid Depth is 400.
- Provide `displayname`, `resourcetype`, `getcontentlength`, `getcontenttype`,
  `getetag`, `creationdate`, and `getlastmodified` where meaningful. Dates use UTC.
  Unknown requested properties receive 404 propstat, including unsupported Finder
  quota/resource-fork properties. Collections have trailing-slash hrefs.
- Use a namespace-aware XML parser with a 32 KiB request-body limit and explicit
  rejection of DTD/entity declarations. Limit nesting to 16 and requested
  properties to 128. Malformed XML is 400; oversized XML is 413. Limit each
  collection response to 10,000 children and return 507 instead of silently
  truncating or allocating an unbounded response. Iterate catalog pages within
  that limit so collections with more than one REST page remain complete.
- GET/HEAD files stream the same bytes and strong ETags as REST. Honor a single
  byte Range, suffix/open-ended ranges, If-Range, If-None-Match, 206 and 416, and
  HEAD content lengths. Do not buffer whole files. Collection GET/HEAD has no
  synthetic file content; browsing uses PROPFIND.
- PUT, DELETE, MKCOL, COPY, MOVE, PROPPATCH, LOCK, and UNLOCK are rejected with
  405 after authentication, without catalog or filesystem mutation.

## Validation and acceptance

Use generated bytes and isolated temporary catalogs. Tests must demonstrate:

1. An enabled server reports the feature; a disabled one does not expose DAV.
2. Unauthenticated PROPFIND/OPTIONS and loopback/LAN-only admission are refused.
3. Bearer and both Digest algorithms can authenticate and read. Wrong passwords,
   malformed headers, URI/method mismatches, stale/tampered nonces, replay, expired
   credentials, and revocation fail without credential leakage. Concurrency does
   not falsely reject distinct valid nonce counts.
4. Issuance/list/revocation ownership, session-only management, read-only Digest
   authority, password-reset revocation, and no-store/secret-free responses hold.
5. Migration 8 upgrades an existing version-7 catalog, preserves its rows, and
   opens twice; unsupported schema versions remain hard errors.
6. DAV and REST middle-range bytes, ETags, and range response headers agree on a
   real server listener. Include HEAD, suffix, unsatisfiable, conditional, and
   secondary/offline-location cases.
7. User/item/guest ACLs filter listings and direct access, including restricted
   assets, scoped guests, scanned roots, and membership/grant changes.
8. Depth/property XML semantics, unknown properties, Unicode/special names,
   pagination beyond one catalog page, traversal, symlink escape, hostile XML,
   body limits, and mutation rejection are covered.
9. Exercise a real Digest client against the listener, plus a representative
   Finder OPTIONS/PROPFIND/HEAD/ranged-GET sequence. Attempt an isolated native
   Finder mount when practical; report actual client testing accurately.

Run `pnpm verify`, Swift client tests after regenerating models, and the existing
cross-platform CI, Docker, security, and CodeQL checks. Fix failures in the feature
branch before merging. Update OpenAPI/generated clients and the surface snapshot
for additive credential endpoints; do not move DAV methods into `/api/v1`.

## Documentation and limits

Document opt-in enablement, HTTPS/reverse-proxy operation, app-password issuance
and revocation, Finder Connect to Server, rclone/Cyberduck configuration, the
read-only namespace, source availability, and the single-range limit. Do not
include real secrets or operator data. Write support, locks, persistent arbitrary
DAV properties, archive-entry expansion, and changes to playback remain outside
this PR.

## References

- Existing workstream: `docs/workstreams/webdav-compatibility.md`.
- RFC 4918: https://www.rfc-editor.org/rfc/rfc4918.html
- RFC 7616: https://www.rfc-editor.org/rfc/rfc7616.html
- Finder client notes: https://sabre.io/dav/clients/finder/
- rclone WebDAV configuration: https://rclone.org/webdav/
