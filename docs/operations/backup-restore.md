# Backup and restore

Stop the server or accept that `ecs backup` reads a WAL snapshot.

```sh
ecs backup --data ./content-data --to ./backups/2026-10-05
```

The destination receives `library.sqlite`, produced with `VACUUM INTO`, and a copy of `blobs/`. When storage locations are registered, it also receives `locations.json` and `locations/<id>/blobs/` for each one. A location whose directory is absent is offline. `backup` names it and writes nothing, rather than an archive that quietly omits that drive.

Restore by stopping the server, replacing the data directory's `library.sqlite` and `blobs/` with the backup, copying each `locations/<id>/blobs/` back to the path named in `locations.json`, and running:

```sh
ecs doctor --data ./content-data
```

`doctor` runs `integrity_check` and reports catalog blobs whose files are missing. A pending bootstrap token file is expected until the owner account exists.
