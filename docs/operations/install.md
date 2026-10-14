# Install

## Local

```sh
pnpm install
pnpm build
pnpm ecs init --data ./content-data --name "Living Room"
pnpm ecs serve --data ./content-data
```

`init` creates the SQLite database, blob directories, and `bootstrap.token` with mode `0600` where the platform supports it. `serve` repeats init when the data directory is new, then listens on `127.0.0.1:8473`. Additional blob directories are registered with `ecs locations`. See [Storage locations](storage-locations.md).

```sh
curl -s -X POST http://127.0.0.1:8473/api/v1/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"token":"<bootstrap>","username":"owner","password":"<password>"}'
```

Advertise on the LAN after setup:

```sh
ecs serve --data ./content-data --host 0.0.0.0 --advertise
```

Before bootstrap, a non-loopback bind also needs `--allow-lan` or `ECS_ALLOW_LAN=1`.

## Docker

```sh
docker compose up --build
```

The published sample binds host port 8473 to loopback. Read the bootstrap token from `docker compose logs`. Set a persistent volume before loading a library.

## Quotas

`ECS_MAX_UPLOAD_BYTES` and `ECS_MAX_LIBRARY_BYTES` override the defaults of 32 GiB per upload and 512 GiB per library.

## Public TLS

```sh
ecs serve --data ./content-data --host 0.0.0.0 --public --tls-terminated
```

Put a reverse proxy with a certificate in front of the process. The flag records the operator's assertion; the process does not mint a certificate.

## mDNS

`--advertise` publishes `_pvcontent._tcp`. The TXT record contains `id`, `v`, `tls`, `pair`, and `name`.

## Content roots

Record the folders that already hold a collection. Nothing is copied and nothing inside a root is ever written. The web interface can browse the server's folders to find one, which is the only way to pick a path when the browser is on a different machine.

```sh
ecs roots add --data ./content-data --path /Volumes/Games --label Games
ecs roots list --data ./content-data
ecs roots remove --data ./content-data --id <rootId>
```

A root must be an absolute path to an existing directory, must sit outside the data directory, and may not overlap a root already saved. The real path is recorded, so the listed path can differ from what you typed when the folder is reached through a symlink. Local changes appear in the audit log as the `cli` actor; the same operations over HTTP are owner-only at `/api/v1/roots`.

## Upgrades

The catalog records every applied schema version in `schema_migrations`. Opening the database runs the migrations this build knows and has not applied yet, each in its own transaction, so an upgrade needs no separate command. Rows already in the catalog are preserved.

A database written by a newer build is refused with a schema error rather than opened, because this build cannot know which statements it is missing. Downgrade by restoring a backup, not by pointing an older build at a newer data directory.
