# Read-only WebDAV

WebDAV exposes the catalog and scanned content at `/dav/` for Finder, rclone,
Cyberduck, and other DAV clients. Uploads and edits use `/api/v1`. DAV does not
expose the server data directory, implement locks, or unpack archives.

## Enable it

WebDAV is disabled by default:

```sh
pnpm ecs serve --data ./content-data --webdav
```

`ECS_WEBDAV=1` also enables it. Add `--webdav` to `ecs service install` to preserve
that selection in a per-user login service; existing registrations stay disabled
until reinstalled with the option. `GET /api/v1/capabilities` reports
`features.webdav` according to this process's enabled mount.

Use HTTPS when credentials or content cross an untrusted network. Public binds
still require `--public --tls-terminated`; DAV does not change the listen policy.
A reverse proxy must preserve the `/dav/` prefix and exact request URI and forward
Authorization, WWW-Authenticate, Depth, Range, If-Range, and If-None-Match. It must
allow PROPFIND and preserve multiple authentication challenge headers. Do not
rewrite DAV paths or enable anonymous proxy credentials. Forwarded client-address
headers never make a DAV request trusted.

## Issue an app password

Sign in to an account through `/api/v1/auth/login`, then use that session bearer
credential with the management endpoints. Loopback/LAN trust, device tokens,
guests, and Digest app passwords cannot issue or manage DAV credentials.

- `POST /api/v1/webdav-credentials` with `{"name":"Finder"}` returns
  `{"credential":{...},"password":"..."}`. The credential includes its generated
  `username`, ID, timestamps, and expiry. Save the password in your client's secure
  credential store: it is shown once, is not cached for idempotent replay, and
  cannot be retrieved later. Retrying issuance creates a new credential.
- `GET /api/v1/webdav-credentials` lists your metadata, including revoked entries.
- `DELETE /api/v1/webdav-credentials/{id}` revokes one of your credentials.

The generated TypeScript `ContentClient` has `createWebdavCredential`,
`webdavCredentials`, and `revokeWebdavCredential` methods. `login(username,
password)` retains the session credential in the client instance. Handle the
creation result in your application without logging it or putting passwords in
shell arguments/history.

Names are trimmed to 1–80 characters. `expiresInSeconds` defaults to 7,776,000
(90 days) and accepts 60–31,536,000 seconds. Each account may have 32 active
credentials. A credential has read scope only and uses its account's current
library membership and item grants. Revocation, expiry, ACL changes, and account
password reset take effect on the next request. Logout ends a session without
revoking app credentials.

The server stores MD5 and SHA-256 HA1 verifiers for the fixed DAV realm, never the
app password or an extra copy of the account password. Protect catalog backups as
authentication material. SHA-256 is offered first; MD5 Digest is available for
legacy clients using the same high-entropy generated app password. Basic
username/password authentication is not enabled.

## Connect

**Finder:** Go → Connect to Server, enter `https://your-server.example/dav/`, and
choose Registered User. Enter the generated credential username and app password,
not your account password. The share is read-only; Finder metadata writes are
refused. A missing kernel, Spotlight, quota, or resource-fork property is not a
request to expose a physical server directory.

**Cyberduck:** choose WebDAV (HTTPS), the server hostname and port, and `/dav/`
as the path. Use the generated username/app password. The server's Digest
challenges select authentication; the share remains read-only.

**rclone:** use `rclone config` to add a WebDAV remote, vendor `other`, URL ending
in `/dav/`, and the generated username/app password. Supply the password through
rclone's interactive prompt. Existing bearer credentials are also accepted using
rclone's `bearer_token` configuration, with permissions/expiry inherited from that
credential. Do not include real secrets in a checked-in config.

Then browse or copy from the remote, for example:

```sh
rclone lsf ecs:
rclone copy ecs:libraries ./downloaded-content
```

## Names and reads

- `libraries/<library-id>/<item-id>/<asset-id>--<filename>` exposes stored assets.
  DAV displayname properties carry library names and item titles; stable IDs
  keep duplicate names distinct.
- `sources/<root-id>/<relative-path>` exposes scanned files in place. No file
  is copied merely because it is listed. Directory/filename Unicode is normalized
  for lookup; ambiguous source names are refused.
- Collection listings and direct reads both enforce ACLs. Item-scoped guests
  cannot browse other items or scanned roots. BIOS/system files are always hidden
  from guest DAV credentials, even with a restricted-sharing guest capability.
- An unplugged source/storage location returns 503 for reads. A source placeholder
  returns 409 instead of starting an iCloud download. Reconnect or hydrate the
  file through the provider before retrying.
- GET and HEAD support one byte range, conditional reads, 206, and 416. Stored
  blobs have strong content ETags. Mutable sources use weak filesystem metadata
  validators without opening placeholders; If-Range on those sources returns the
  complete current file. Multiple ranges are refused. DAV and REST share readers.

PROPFIND accepts Depth 0 or 1 and returns 207 XML. Send an explicit Depth header:
missing/infinite depth is refused to avoid recursive traversal. Unknown properties
have 404 propstat entries. XML is limited to 32 KiB, 16 nesting levels, and 128
properties; DTD/entity declarations are refused. Collections are limited to 10,000
children per response. Source indexes and visible-item traversal are also bounded
at 10,000 entries/nodes per request; excessive listings fail with 507 rather than
truncate. Hidden item rows are filtered in SQL before pagination.
Authentication nonces last five minutes; clients can retry a stale challenge.
Failed DAV logins have a separate ten-attempt/minute budget. A general ceiling of
6,000 requests/minute per socket peer protects authentication and applies to all
routes; forwarded headers do not change the peer key. Rate-limited requests return
429 and the general ceiling includes Retry-After.

## Verification

Automated tests use generated bytes and disposable catalogs. They cover an
independent curl Digest client, a Finder-style OPTIONS/PROPFIND/HEAD/range sequence,
REST range parity, ACL changes, credential lifecycle, hostile XML/paths, source
placeholders, secondary storage, and migration/reopen behavior. Record the actual
native Finder mount result in the PR; protocol tests alone do not establish that
an installed Finder version was tested.

The Windows SSPI build of curl cannot use SHA-256 Digest, so its native curl test
is skipped; independent SHA-256 and MD5 protocol clients still run on Windows.
Use a curl build with SHA-256 Digest support for that client check.

Protocol references: [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918.html),
[RFC 7616](https://www.rfc-editor.org/rfc/rfc7616.html),
[rclone WebDAV](https://rclone.org/webdav/), and
[Finder client notes](https://sabre.io/dav/clients/finder/).
