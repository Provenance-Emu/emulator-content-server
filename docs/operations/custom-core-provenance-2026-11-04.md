# Published custom-core provenance audit, 2026-11-04

Eight retained custom packages now carry pinned references to their published
source archive, `NOTICES.txt` and `catalog.json` build receipt. The catalog stores
each reference URL, byte length and SHA-256. `sourceMapping: release-receipt`
records the publisher's linkage between those artifacts and the packaged binary.

## Evidence inspected

For each release below, the downloaded receipt and notices matched the GitHub
release asset byte lengths and SHA-256 digests. The receipt's manifest ID and
package hash matched the retained catalog entry and release package digest. Its
source/archive and notice artifact pins matched release asset metadata.

| Profile | Published build receipt | Reported core revision |
| --- | --- | --- |
| `org.libretro.prosystem` | [Receipt](https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-prosystem-2026.10.31.1/catalog.json) | `8a88014287c7a01cd568067e5a557d0a2b2a051f` |
| `org.libretro.stella2014` | [Receipt](https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-stella2014-2026.10.31.1/catalog.json) | `7d1361e407e63f29e52892655069e5fb4096e691` |
| `org.libretro.freeintv` | [Receipt](https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-freeintv-2026.10.31.1/catalog.json) | `ef3e0fe322bec62a7f916c0bb0834c08c348d0b4` |
| `org.libretro.atari800` | [Receipt](https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-atari800-2026.10.31.2/catalog.json) | `4e7fbc73765c1a9670c7506616046ad1d4ccda51` |
| `org.libretro.pokemini` | [Receipt](https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-pokemini-2026.10.31.1/catalog.json) | `132111b76343559860532a1ccc094f93f1ed5650` |
| `org.libretro.potator` | [Receipt](https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-potator-2026.10.31.1/catalog.json) | `227c5f6f3ce74d32e9002ce24c1420288559a860` |
| `org.libretro.sameduck` | [Receipt](https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-sameduck-2026.10.31.1/catalog.json) | `040e19c379f00dae10afe0eb0c1b2b019b985bbe` |
| `org.libretro.mednafen-pcfx` | [Receipt](https://github.com/Provenance-Emu/emulator-content-server/releases/download/browser-core-mednafen-pcfx-2026.10.31.1/catalog.json) | `c1650bad5fbdcc3c3ccd45e29e3983e1ccf16cff` |

The receipts retain frontend and SDK revisions, compiler details and build
recipes. Their `reproducible: true` values are publisher-reported. This audit
downloaded the small receipts and notices. Source-archive pins were checked
against release metadata. An independent source rebuild and dependency-notice
completeness review remain outstanding.

## Incomplete evidence

- FCEUmm retains its existing `v0.1.4-cores.1` source-archive reference and exact
  release asset pin, with `sourceMapping: unverified`. Matching build and notice
  receipts were unavailable in the inspected release.
- The current Jaguar `v0.1.6-jaguar-media.1` package has no matching source, notice
  or build receipt in the inspected release. It remains `unverified`. The older
  Jaguar source archive was excluded because it belongs to another artifact.
- Official loader/WASM pairs retain pinned core-info/license/firmware metadata.
  Exact corresponding-source/build mappings remain unknown for those pairs.

## Snapshot and cache behavior

These optional version-1 fields are retained in canonical catalog identities.
Older reviewed snapshots remain readable. Metadata changes produce new entry
and package-cache keys, including when the package bytes match an earlier entry.
Keep the older reviewed catalog file and pin for offline reuse of its existing
cache. The eight receipt-linked packages and two legacy entries acquire new keys.

Artifact references are operator metadata. The server validates their shape and
HTTPS URLs when loading a snapshot. It does not download or execute source,
notices or build receipts. Package downloads retain the existing trust checks.

Installed profiles retain their selected versions. The public player response
continues to omit internal provenance metadata.

## Follow-up evidence, 2026-11-05

The [subsequent source audit](./core-source-audit-2026-11-05.md) supersedes the
legacy evidence gaps above. Both FCEUmm and the current Jaguar runtime pair were
reproduced byte-for-byte from published source. Jaguar's source link crosses to
the preceding CD HLE release. All eight newer source archives and package
manifests were inspected, with named notice inventories and pinned SDK notices.
The 50 official upstream mappings and dependency-notice completeness remain open.
