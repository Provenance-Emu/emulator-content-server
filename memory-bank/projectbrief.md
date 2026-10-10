# Project brief

The emulator content server is a headless library server that shares emulator ROMs, saves, screenshots, artwork, BIOS, and system files between Provenance, iCube, iFly, and future clients.

## Source of truth for scope

This repository owns the versioned HTTP contract, storage, access control, and reference clients. The emulator apps stay adapters. `packages/protocol/openapi/openapi.yaml` is the contract; every client model is generated from it.

## In scope

- Original bytes served with single-range reads.
- Resumable uploads with a staging directory and content-addressed placement.
- Library roles, per-item grants, guest grants, and device tokens.
- A monotonic change cursor that clients poll.
- `_pvcontent._tcp` mDNS advertisement.
- Backup and restore of the catalog and blobs.

## Out of scope

- Signing, JIT activation, and IPA distribution. These are a separate future product with a separate repository, process, database, and credential store. See `docs/workstreams/sideload-jit-isolation.md`.
- App-specific Realm, Dolphin, CloudKit, and UIKit code. Those belong in the app repositories.
- A relay for remote access. VPN is the supported path until a new ADR exists.

## Non-negotiable rules

One logical change per pull request, with tests for the behavior that changed. Each package owns a fixed set of paths, listed in `AGENTS.md`. Never commit ROM, BIOS, disc, or save fixtures; tests allocate their own bytes.
