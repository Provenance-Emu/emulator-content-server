# Container install

`deploy/docker/Dockerfile` builds the server. `compose.yaml` is the path for a VM or a cloud host. The image does not contain a library, a ROM folder, or a bootstrap token.

## Owned paths

- `deploy/docker/Dockerfile`
- `compose.yaml`
- `docs/operations/install.md`

## Behavior

- The data directory is the `/data` volume. A collection is a separate mount, registered as a content root, and not copied into the volume.
- Inside the container the process binds `0.0.0.0`. The published sample maps that port to host loopback only.
- Docker's bridge presents every published connection as a private address such as `172.17.0.1`. The default `lan` rule would treat that address as a member of the library. Publishing the port on every interface would therefore hand read and write to anyone who can open it.
- A cloud or VM publish uses access mode `token` and starts with `--public --tls-terminated` behind a TLS proxy. `--public` is what stops the bridge address, and a proxy's loopback connection, from becoming the owner. The server does not trust `X-Forwarded-For`.
- `network_mode: host` is the home-LAN alternative. The socket address is the real client again, and `lan` means the LAN.

## Acceptance

- `docker compose up --build` persists `/data`, publishes loopback, and still requires the bootstrap token before library bytes are served.
- The image contains no ROM, BIOS, save, or token.
- The install doc says that a public port requires `token` mode and `--public --tls-terminated`.

## Non-goals

A hosted relay, automatic TLS inside the process, and scanning a mounted folder without the operator registering it.
