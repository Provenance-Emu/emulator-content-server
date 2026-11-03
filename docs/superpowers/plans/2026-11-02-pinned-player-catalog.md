# Operator-pinned player catalogs

Continuation of #29's approved immutable snapshot architecture. The next batch
makes a reviewed snapshot selectable independently of the application release.

## Design

Use an explicit local catalog file and expected canonical snapshot SHA-256 ID.
The operator supplies both; a file's self-declared hash alone conveys no trust.
Validate the complete version-1 envelope and every entry before opening the
catalog database or changing installed profiles. Preserve download host rules,
matched resource tables, byte caps, runtime manifests and provenance metadata.

Alternatives: a remote mutable channel needs additional channel trust and fetch
policy, so it remains deferred; keeping catalogs compiled into ECS would leave
the existing snapshot format unusable for independent updates. Local selection
uses the current format and operator trust model without an HTTP API change.

Expose `ecs player-catalog export --to FILE` for a new, non-overwriting snapshot
of the bundled catalog. `ecs serve` and service registration accept paired
`--player-catalog FILE --player-catalog-id SHA256` flags (or paired environment
values). Changing the file/pin requires a restart. Existing installations stay
pinned; catalog rollback selects an old reviewed file/pin and can reuse its exact
cached bytes. This does not introduce an installed-version replacement API.

## Execution

- [x] Write failing snapshot import tests: expected-ID mismatch, schema/entry
  validation, sizes, mixed pair pins, executable manifests, URL trust, duplicate
  IDs, invalid UTF-8 and nonregular files. Prove bundled snapshot round trips.
- [x] Add bounded, strict snapshot loading and exclusive export; share descriptor
  and URL validation with the existing downloader.
- [x] Write failing server selection tests. Prove selecting a new catalog keeps
  installed bytes pinned and selecting an older one allows verified offline
  reuse, while invalid selection fails before touching the data directory.
- [x] Add server configuration and CLI export/paired flags, retaining both values
  in generated service registrations. Test flags, environment, missing values,
  export non-overwrite and service arguments with generated fixtures.
- [x] Run focused Node 22 tests/build, affected lint, boundaries, drift and secret
  scan. Review the operator-trust boundary and atomicity once, then commit/push
  the batch on the existing main checkout as authorized.

## Validation and review

Focused server/CLI build and 89 affected tests passed on Node 22.22.2. After
strengthening export to publish complete files atomically without replacement,
the 24 import/export and CLI tests passed again. Affected Biome checks, boundaries,
client drift, secret scan and whitespace checks passed. No browser or native
service was opened; temporary CLI servers closed after the tests.

Trust-boundary review checked independent expected-ID anchoring, full candidate
validation before database initialization, URL allowlists on initial and redirect
requests, data-only manifests, bounded regular-file reads, immutable per-manager
selection, and persistence of both service arguments. Export uses exclusive
staging plus a non-overwriting link. No remote channel or installed-version
replacement is introduced. The bundled round-trip regression exposed and now
fixes the existing lowercase-only guard for official DoubleCherryGB filenames.
