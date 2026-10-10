# Backup and restore

Stop the server or accept that `ecs backup` reads a WAL snapshot.

```sh
ecs backup --data ./content-data --to ./backups/2026-10-05
```

The destination receives `library.sqlite`, produced with `VACUUM INTO`, and a copy of `blobs/`.

Restore by stopping the server, replacing the data directory's `library.sqlite` and `blobs/` with the backup, and running:

```sh
ecs doctor --data ./content-data
```

`doctor` runs `integrity_check` and reports catalog blobs whose files are missing. A pending bootstrap token file is expected until the owner account exists.
