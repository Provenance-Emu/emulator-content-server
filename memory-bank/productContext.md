# Product context

## Why this exists

Emulator libraries are large, duplicated across devices, and awkward to move. Each app previously grew its own sync path. Consolidating into one server means a household keeps one library and every app reads the same bytes over one versioned contract.

## Problems it solves

- A phone, a TV, and a desktop see the same catalog without copying whole libraries.
- A partially downloaded multi-gigabyte disc image resumes instead of restarting.
- A guest can be handed read access to one item without gaining the library.
- Restricted content stays restricted: BIOS and system files are hidden from guest credentials unless the operator turns on restricted sharing.

## How it should work

The operator runs `ecs init` then `ecs serve`. The first run prints a one-time bootstrap token and binds `127.0.0.1:8473`. Nothing is exposed until the owner is created through `POST /api/v1/auth/bootstrap`. A client discovers the server over mDNS or accepts a manual base URL, authenticates with a bearer token, and polls `GET /api/v1/changes` for catalog deltas.

## Experience goals

- Safe by default. A non-private exposure requires `--public --tls-terminated`.
- Resumable by default. A ranged GET that returns 200 instead of 206 means the client discards its partial file and starts over, which is the behavior encoded in `ResumePlanner`.
- Honest about capability. `GET /api/v1/capabilities` reports exactly what the running server supports, so a client never has to guess.
