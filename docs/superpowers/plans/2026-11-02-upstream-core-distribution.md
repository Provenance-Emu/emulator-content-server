# Upstream Core Distribution Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Retain coherent verified core packages and immutable curated catalog snapshots for offline reuse.

**Architecture:** Canonical JSON identities freeze the complete catalog and each entry. A server-owned, bounded cache publishes whole packages and catalog receipts atomically, and validates every cache hit against the trusted descriptor. The existing owner installer consumes it without changing the API.

**Tech Stack:** TypeScript, Node filesystem APIs, node:test; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-02-upstream-core-distribution-design.md` (approved 2026-11-02).

## Global Constraints

- Preserve current custom cores and installed profiles; no automatic updates or remote channels.
- Retain exact byte pins and upstream metadata; no binaries or firmware committed.
- Keep existing download allowlists and owner authorization.
- Cache cap: 512 MiB including catalog receipts and temporary writes; skip new caching when full, without eviction or failing a valid online install.
- Execute in the existing checkout; publish the authorized consolidated batch to main if signing succeeds.

## Review Focus

- Descriptor metadata changes must not reuse a package with an older manifest.
- Corrupted, symlinked or incomplete cache entries must never be served.
- Concurrent requests and partial failures must not publish mixed pairs.
- A full cache must preserve retained versions and permit a verified online install.
- Installer restart/removal must leave verified cache bytes available offline.

### Task 1: Immutable catalog identity

Files: create `apps/server/src/player-catalog-snapshot.ts` and `apps/server/test/player-catalog-snapshot.test.ts`; extend provenance in `player-catalog.ts` and `player-catalog-upstream.ts`.

Interface: `createPlayerCatalogSnapshot(entries: readonly TrustedPlayer[]): PlayerCatalogSnapshot`, with `schemaVersion: 1`, SHA-256 `id` and immutable entries; `playerCatalogEntryId(entry): string`.

- [x] Add tests for stable key ordering, changed pair/runtime/provenance identities, detached immutable input and duplicate-ID rejection; build and observe failure.
- [x] Implement canonical serialization, deep freezing and upstream provenance retention.
- [x] Run snapshot tests and TypeScript build.

### Task 2: Verified complete package cache

Files: create `apps/server/src/player-cache.ts`, `apps/server/test/player-cache.test.ts`; reuse generated downloader fixtures.

Interface: `PlayerPackageCache(directory: string, maxBytes?: number)` and `download(snapshot: PlayerCatalogSnapshot, id: string): Promise<Buffer>`.

- [x] Write failing tests covering offline reuse after restart, changed upstream bytes, unavailable downloads, manifest substitution, corrupted/symlinked files, full-cache behavior, concurrent requests, coherent revisions and old-descriptor reuse.
- [x] Implement serialized bounded regular-file reads; verify package identity and all manifest/resource pins; stage and link complete files without overwriting existing snapshot names; retain catalog receipts.
- [x] Run focused cache/downloader tests and TypeScript build.

### Task 3: Owner installation integration and consolidation

Files: modify `player-manager.ts`, add integration coverage to `player-manager.test.ts`, update operating notes and design status.

- [x] Write and observe a failing install/remove/restart/offline-reinstall regression through owner routes using generated upstream fixtures.
- [x] Freeze the manager catalog at construction and route catalog downloads through its data-directory cache; keep public API fields unchanged.
- [x] Run affected server tests, build, Biome, package boundaries, secret scan and whitespace checks.
- [x] Conduct one focused independent storage/concurrency review; fix material findings and rerun affected checks.
- [x] Commit and push the consolidated main batch with signing enabled; preserve unique cleanup work and archive redundant worktrees only after preserving their artifacts.

## Execution ledger

Ruling: Execute natively after the user's explicit approval to proceed; no additional planning approval loop.
Ruling: Cache admission skips new entries when capacity is exhausted instead of evicting retained versions; this preserves offline rollback candidates without retention machinery.

Review: Sonnet 5 found no correctness bug or material design gap. The existing management queue waits behind downloads; crash cleanup remains manual and documented. Neither blocks this pre-release batch.
