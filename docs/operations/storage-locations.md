# Storage locations

In the app, open **Settings → Storage**. **Folders on server** links existing files to libraries without copying them. **Uploaded files** selects a destination for new uploaded copies. **Remote storage** explains how to mount a network/cloud folder on the server computer and use it in either role. These tabs do not change storage just by opening them.

A library is a named collection with access permissions; a folder is a physical source of files. Existing folders that predate libraries appear under **Use your existing game folders** on the home screen, empty libraries, and settings. Select a destination library and choose **Add selected folders** to link and scan them. No files move. Reselecting a folder already in that library refreshes its scan; an unassigned duplicate offers **Use existing folder**. Folders assigned to a different library are never silently moved.

**Scan saved folders** appears when a library has folders with no completed scan. **Library tools → Scan folders for games** scans linked folders again; settings also has a scan button per folder. Scan failures remain visible after a successful link, with a route to the destination library for retry. Scanning discovers files and infers their systems. **Match library** separately finds metadata and artwork; provider coverage and filename/checksum evidence determine those results.

The desktop app uses the operating system folder dialog for its verified local service. A browser’s native folder chooser selects files on the browser device for upload; it cannot expose an absolute directory on a remote server. **Add server folder** therefore uses the compact server-directory browser, including when the desktop app is connected to a remote server.

The data directory is the primary blob store and is always present. Another directory can hold blobs when the library outgrows that disk. The address is still the SHA-256, and the content routes do not change.

```sh
ecs locations add --data ./content-data --path /mnt/library --label Library
ecs locations use --data ./content-data --id <locationId>
ecs locations list --data ./content-data
ecs locations use --data ./content-data --primary
ecs locations remove --data ./content-data --id <locationId>
```

`add` records the real path. The directory has to exist, stay outside the data directory, and not overlap a location or a content root. The location receives `blobs/sha256/` only. Staging uploads and `virtual-cache` stay in the data directory, so a half-finished upload never lands on a removable drive.

`use` chooses where new bytes are written. `use --primary` sends them back to the data directory. A digest that is already stored is not copied to the new target. Removing a location is refused while it is the write target or while the catalog still names a blob there.

A location is online when its `blobs/` directory is present. Unplugging the drive, so that directory is gone, makes reads of those blobs fail with `location-offline` instead of a missing-file response. Blobs in the primary directory are unaffected. `doctor` reports `offline location <label>` separately from `missing blob <hash>`, and it checks every blob in a location that is online.

`backup` copies every location or refuses before it writes, naming each offline location. The destination layout is described in [Backup and restore](backup-restore.md).
