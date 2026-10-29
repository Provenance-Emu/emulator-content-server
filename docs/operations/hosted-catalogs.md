# Hosted matching catalogs

Hosted catalogs are versioned public JSON data. They contain game identity facts,
source attribution, and links to immutable cheat/patch resources. They contain no
ROM, BIOS, disc or save bytes. Matching requests never upload ROM facts, filenames,
local paths, cookies or server credentials to the catalog host.

The server's matching worker loads the committed `HOSTED_CATALOG_PIN` in
`packages/plugins/src/catalog-release.ts`: `{ url, sha256, bytes, release }`.
Changing this pin is a publication/update decision, after the corresponding
versioned assets pass validation. **Update catalogs and find matches** warms the
selected systems in that pinned release; it does not trust an unpinned `latest`
manifest or replace existing saved choices.

The existing `org.ecs.libretro` provider uses hosted metadata for supported
systems and retains public thumbnail lookup/corroboration. Unsupported systems
use the previous bounded DAT provider. A supported hosted system with no hits
returns no metadata instead of downloading the old DAT again. The SDK also
exposes standalone `org.ecs.catalog.metadata`, `org.ecs.catalog.cheats` and
`org.ecs.catalog.patches` providers. The worker lists the latter two separately;
its existing Libretro cheat ID delegates to hosted cheats when available. If both
cheat IDs are selected, the hosted search runs once.

## Artifact contract

`@ecs/plugins/hosted-catalog` exports the interfaces and validators. An index is:

```json
{
  "version": 1,
  "release": "catalog-example.1",
  "sources": [{
    "id": "original",
    "name": "Original generated catalog example",
    "url": "https://github.com/example/catalog",
    "revision": "original-example-v1",
    "license": "CC0-1.0",
    "notice": "Generated demonstration facts; no commercial game coverage claimed"
  }],
  "shards": []
}
```

Each shard descriptor has `id`, `kind` (`metadata`, `cheats`, `patch`), `systemId`,
`url`, `sha256`, `bytes`, `records` and `sourceIds`. A shard is
`{ version: 1, release, kind, systemId, records }`. Each record has a stable `id`,
`title`, `name`, `sourceIds`, optional DAT identity fields (`size`, MD5/SHA1/CRC,
serials, set IDs, aliases, disk media), and up to six optional descriptive
metadata fields. Referenced sources must exist in the manifest and shard.

Cheat/patch records additionally declare
`resource: { url, sha256, bytes, format }`. Cheats use `retroarch-cht`; patches use
`bps`, `ups` or `ips`. Identity hashes and size describe the expected source ROM
representation, not the downloaded patch/cheat bytes. Download integrity uses the
separate resource SHA256 and byte length. Translation/hack labels are explicit
`metadata.patchType` values, with optional language/revision metadata.

The index is capped at 256 KiB, each shard at 16 MiB, cheat resources at 256 KiB,
and patch resources at 2 MiB. There are at most 64 source definitions, 256 shards
and 512 MiB of declared shards. Initial fetch targets are HTTPS GitHub versioned
release assets or raw files addressed by a 40-digit source commit. Credentials,
queries, fragments, alternate ports and arbitrary hosts are rejected. At most
three manual redirects may reach the explicit GitHub release-asset hosts; signed
query parameters are allowed only on those redirected asset URLs. Every
manifest, shard and resource is independently bounded and hash checked.

## Worker and cache behavior

`createHostedCatalog({ pin, fetcher?, cacheDirectory? })` exposes `index()`,
`metadata(input, signal?)`, `providers()`, `sync({ systemIds? }, signal?)` and
`resource({ release, shardId, recordId }, signal?)`. `metadata()` returns `null`
only for an unsupported system, preserving the legacy fallback distinction.
Sync validates/downloads selected shards and returns `{ release, shards, records }`;
it does not download cheat or patch payloads or compile every system's indexes.

Parsed shards and lazily compiled matching indexes retain at most two systems
within a 64 MiB estimate. A third system evicts the oldest whole system bucket;
several shards from one system do not hit an arbitrary shard-count limit. A
single system exceeding that memory budget cannot retain all shards, so large
queues should group work by system. The shared raw text cache is separately
bounded at 32 MiB. Warm immutable disk bodies remain usable offline beyond the
mutable loader's normal six-hour TTL only after regular-file/no-symlink checks,
exact byte length and pinned SHA256 verification. Corrupt or incomplete bodies
are never accepted as an offline fallback.

The child-process operations are `catalog-sync` with optional `catalogSystems`,
and `catalog-resource` with a release/shard/record reference. Resource requests
cannot supply a URL. A stale release reference is rejected. The worker returns
raw bytes plus the validated format, length, digest and release. The HTTP host
rechecks that proof, then validates/normalizes every cheat disabled before saving,
and validates patch structure and embedded base identity. Matching never enables
cheats or applies patches. Cancellation/deadlines use the existing worker pool's
process retirement and replacement boundary.

## Sources and publication

Build from pinned source checkouts with `scripts/build-hosted-catalog.mjs` and its
`scripts/catalog-sources.json` input. Publish new versioned assets and verify
their sizes/digests before changing the committed pin. Source notices accompany
the manifest and build receipts. Public metadata revisions are not proof that
all underlying data or linked patch/code content has one common license.

The [Libretro database repository license](https://github.com/libretro/libretro-database/blob/master/LICENSE)
is CC BY-SA 4.0; its [README](https://github.com/libretro/libretro-database) describes
third-party DAT sources and heterogeneous cheat contributions. Preserve upstream
attribution, exceptions and adaptation notices. Flycast's
[Naomi catalog header](https://github.com/flyinghead/flycast/blob/master/core/hw/naomi/naomi_roms.cpp)
identifies MAME ROM information under LGPL-2.1+ within a GPL-2.0-or-later source
file. Its scalar facts are parsed as data; C++ is never evaluated. Linked
resources with unverified or separate terms remain source links, with honest
notices; a catalog does not grant rights to the underlying game or translation.
