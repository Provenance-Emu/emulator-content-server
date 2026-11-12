# Jaguar catalog and companion files

This contract covers the [Emulation Server changes in #33](https://github.com/Provenance-Emu/emulator-content-server/issues/33) and the client handoff for [Virtual Jaguar library tabs](https://github.com/libretro/virtualjaguar-libretro/issues/1203) and [companion downloads](https://github.com/libretro/virtualjaguar-libretro/issues/1202).

## Native Emulation Server

Get authorized library IDs from `GET /api/v1/browse-libraries`. Each library has its own cursor. Use separate requests for the cartridge and CD tabs.

```http
GET /api/v1/browse?libraryId=library-demo&category=games&systemId=com.provenance.jaguar&limit=10&includeRomDownload=true
GET /api/v1/browse?libraryId=library-demo&category=games&systemId=com.provenance.jaguarcd&limit=10&includeRomDownload=true
```

Keep the filter and limit when sending the returned `nextCursor`. A null cursor ends that library's results. `systemIds=com.provenance.jaguar,com.provenance.jaguarcd` selects both within one library. `systemCounts` provides readable counts before system selection. A catalog mutation can invalidate a cursor. On a 400 cursor error, refresh the affected library from its first page.

Use `entityType` and `id` to retain game identity. An uploaded item can include `romDownload` when requested. For one visible ROM it includes a basename and exact byte size.

```json
{
  "romFileCount": 1,
  "requiresSystemFiles": false,
  "filename": "Example.j64",
  "sizeBytes": 2097152
}
```

For multiple ROM files, the summary gives their count. A true `requiresSystemFiles` indicates the current reader can also see required BIOS or system files in the manifest. An uploaded item with zero ROMs may be a catalog placeholder. Request `GET /api/v1/items/{itemId}/manifest` only when the user opens game details or imports it. Use the manifest's authorized `contentPath` values to download files, and retain their relative paths. On an older ECS server the optional `romDownload` field is absent. Clients can browse as usual and resolve details when needed.

Scanned games use `source.name`, `source.size`, `source.availability`, `source.groupFileCount`, and `source.groupError`. Request the source's `/group` when importing a disc set. Use its `/bundle` or retain member paths when downloading files individually. Disc descriptors and tracks are game files.

Load covers lazily from `source.artworkPath` or `/api/v1/files/{previewAsset.id}/content`. An absent path or preview asset means a placeholder is appropriate. For a scanned source, `GET /api/v1/sources/{sourceId}/matches/selections?includeArtworkRoles=true` lists saved artwork roles. A client can send `If-None-Match` when the artwork endpoint supplies an ETag. Authorization runs before the server returns 304.

## RomM gateway

Use the existing routes and ECS read bearer. `GET /api/platforms` derives visibility and counts from the caller's readable libraries. Platform IDs remain derived from ECS system identifiers. Keep the existing gateway SQLite index across upgrades for stable numeric ROM IDs. The additive `ecs_system_id` field identifies the exact ECS platform. The gateway reports `jaguar` and `jaguarcd` as separate slugs.

```http
GET /api/platforms
GET /api/roms?platform_ids=REPLACE_WITH_JAGUAR_ID&limit=10&offset=0
GET /api/roms/42
GET /api/roms/42/content/Example.j64
GET /assets/romm/ecs/42/cover
```

Each browse row includes numeric `id`, `platform_id`, `platform_slug`, display name, and the Manic download filename `fs_name`. `fs_size_bytes` is present for single files. The generated archive size is unspecified. `path_cover_large` is present when a cover is available. It serves the original image and supports authenticated revalidation. This gateway does not generate thumbnails.

Libraries are visited in ID order. Within each library the ECS browse order is used. As in the original Manic API, a nonterminal page can omit `total`. The gateway still walks ECS cursors to translate a legacy offset. Native clients can use ECS cursor paging directly when offsets are unnecessary. The gateway retains its filename-based single-file and grouped ZIP download behavior. Direct connections to real RomM should use the upstream RomM contract for pagination and individual file downloads.

## Optional companions

| Entity | List | Currently supported |
| --- | --- | --- |
| ECS scanned source | `GET /api/v1/sources/{sourceId}/companions` | Saved patch |
| ECS uploaded item | `GET /api/v1/items/{itemId}/companions` | None |
| ECS RomM gateway | `GET /api/roms/{romId}/ecs-companions` | Mirrors ECS for that entity |

```json
{
  "supportedKinds": ["patch"],
  "items": [
    {
      "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "kind": "patch",
      "required": false,
      "filename": "translation.bps",
      "sizeBytes": 144,
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "format": "bps",
      "base": { "crc32": "12345678", "sizeBytes": 2097152 },
      "contentPath": "/api/v1/sources/source-demo/companions/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/content"
    }
  ]
}
```

Download `contentPath` on the same origin with the same bearer used to list the game. The gateway rewrites the path to `/api/roms/{romId}/ecs-companions/{id}/content`. The SHA-256 identifies the exact snapshot. A replaced selection or an unavailable companion returns 404. A reader lacking permission for the snapshot cannot discover or download it. Authorized conditional requests can receive 304. Compare the digest after download.

A BPS or UPS patch can include its expected base CRC32 and input length. Compare both against the client's exact base bytes before offering to apply it. IPS has no embedded base checksum. Saved patches are optional. The `mod` and `texture_pack` kinds are reserved and currently unsupported. An empty `supportedKinds` array means the entity offers no companion capability. A supported kind with an empty `items` array means there is no readable selection. Real RomM servers can return 404 for the ECS gateway extension. Discover and handle any RomM-native companion support through that server's own API.

## Request counts

The loopback integration test seeds 120 uploaded Jaguar cartridges and 20 uploaded Jaguar CD games in two libraries, plus an unrelated game and the empty bootstrap library. The table counts upstream HTTP calls and uncompressed JSON bytes for one request. A deep page uses offset 125 and crosses the library boundary. Depending on the empty library's ID, the gateway can make one fewer browse call.

| Request | Before calls | After calls | Before upstream bytes | After upstream bytes |
| --- | ---: | ---: | ---: | ---: |
| Native first or next 10, default projection | 1 | 1 | 5,195 | 5,195 |
| Native first 10, with download summary | 1 | 1 | 5,195 | 6,205 |
| Gateway platform list | 4 | 4 | 2,292 | 2,292 |
| Gateway first 10 | 14 | 2–3 | 53,975 | 7,376–7,424 |
| Gateway 10 at offset 125 | 141 | 4–5 | 132,191 | 82,227–82,275 |

Before the change, browse fetched 11 manifests for the first page and 136 at offset 125. Both revised pages fetch zero manifests when ECS returns summaries. Scanned-source artwork takes one upstream request per image or revalidation. Uploaded-item artwork uses a manifest and the authorized image endpoint on demand. The fixture asserts cross-library paging, missing and present artwork, custom platform visibility, immutable patch identity and permission checks. The existing Manic fixture covers single files, ranges, M3U bundles and NAOMI ZIP plus CHD layout.

Run the fixture locally.

```sh
pnpm exec tsc -b apps/romm
node --no-warnings --test apps/romm/dist/test/gateway.test.js
```

## Prelaunch rollout

The ECS v1 changes are additive. For native browse, any build with `systemIds` and cursor paging supports the Jaguar tabs. Discover the additions at `GET /api/v1/capabilities` using `features.romDownloadSummaries` and `features.gameCompanions`. The minimum version is the first ECS build advertising the relevant feature. Record its build SHA in the Jaguar release notes after publishing. Publish and apply the ECS OTA first, retaining the catalog. Then update the RomM gateway while retaining its index. Finally enable the Jaguar client features against a matching nightly. The updated gateway retains its manifest fallback when pointed at older ECS builds. Manic can keep its existing gateway address and tokens.

Before client release, run the Jaguar app against native ECS, this gateway, and a real RomM instance. Use generated or redistributable cart and CD content, a game with missing cover art, and a read grant that cannot see a companion. Verify the installed server and gateway versions before recording that matrix as passed.
