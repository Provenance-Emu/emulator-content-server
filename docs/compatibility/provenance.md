# App compatibility

## Provenance

Store `systemIdentifier` values from `GET /api/v1/systems` when the game comes from Provenance. The list matches Provenance's dotted identifiers, including mixed-case values such as `com.provenance.32X` and `com.provenance.appleII`. Other dotted identifiers are valid and are not a protocol error.

Item `md5` and `crc` match the portable game fields Provenance already exchanges. The server also returns SHA-256 on every asset. Save-state and battery-save assets are separate kinds so a client can sync them without treating them as ROMs.

The manifest is the pull document. A client that already understands a file list with relative paths, sizes, and checksums can map `rom` to its game file and leave BIOS management local unless the user opts in.

## iCube and iFly

Use the same item, manifest, upload, and range routes. iCube's Dolphin random-access reader should call `GET /api/v1/files/{id}/content` with `Range`, not a WebDAV GET. The content route returns 206, `Accept-Ranges`, `Content-Range`, and a strong ETag. WebDAV compatibility is a later gateway and is not the canonical API.

## RetroAchievements

Do not send RetroAchievements passwords to this server. A later metadata worker may store an encrypted user token. The foundation keeps MD5 and CRC so a client can identify a game locally.

## WebDAV and SMB

Existing anonymous WebDAV upload servers in the apps are a different trust model. Do not point them at this data directory. An authenticated WebDAV facade is a follow-on workstream.
