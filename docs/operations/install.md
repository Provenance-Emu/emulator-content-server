# Install

## Local

```sh
pnpm install
pnpm build
pnpm --filter @provenance-content/server exec ecs init --data ./content-data --name "Living Room"
pnpm --filter @provenance-content/server exec ecs serve --data ./content-data
```

`init` creates the SQLite database, blob directories, and `bootstrap.token` with mode `0600` where the platform supports it. `serve` repeats init when the data directory is new, then listens on `127.0.0.1:8473`.

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
