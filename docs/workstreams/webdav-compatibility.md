# WebDAV compatibility

Add an authenticated WebDAV facade for Finder, rclone, and Cyberduck. The canonical app API remains `/api/v1`.

## Owned paths

- `packages/webdav` (new)
- `apps/server` mount of that package
- contract capability flag `features.webdav`
- tests

## Behavior

- Require a bearer or digest credential tied to the same ACL evaluator. Anonymous write is not allowed.
- Honor single `Range` on GET, including 206 and 416. A whole-file GET must not be the only read path.
- Reject symlink and lexical escape with the storage path helper.
- Keep BIOS and system files hidden from guest credentials.

## Acceptance

- A contract test fetches a middle byte range and compares it to the REST content route.
- An unauthenticated PROPFIND is rejected.
- The capability document reports `webdav: true` only when the facade is enabled.

## Non-goals

Replacing the JSON API, or serving the data directory as the process root.
