# Storage locations

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
