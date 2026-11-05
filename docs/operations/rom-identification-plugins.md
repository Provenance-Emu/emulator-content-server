# ROM identification plugins

Identification and catalog matching are separate plugin stages. The HTTP process checks the source ACL, containment, availability and current identity. It sends a trusted local path only to the isolated reader worker. Online catalog providers receive bounded facts, never that path or ROM bytes. The shared queue owns the work; cancellation retires the worker and its native reader process group. Results persist against source identity and the reader/configuration version, so another browser or later matching pass reuses the same evidence.

## Reader contract

An offline `provider` manifest with `rom` capability may export `identify(request, reader, signal)`. Normal matching providers keep their `search` export; an identification-only provider may return no search results. See [the homebrew example](../../examples/plugins/rom-identifier/entry.mjs). Install it using the existing `--matching-plugins` directory. Restart after changing an identifier, its entry module or its native tools so the configuration fingerprint and module cache refresh together.

`reader.read(offset, length)` and `reader.stream(offset, length)` supply bounded data from one opened source. `reader.runTool` supports the configured native adapters with bounded output, deadlines and joined termination. The broker permits one active native reader per worker, preventing a plugin from fanning out decoder processes. A WASM library can implement the same JavaScript `identify` export and consume bounded windows; there is no separate unrestricted path/network ABI for a WASM identifier. Additional container readers can use that contract without changing the HTTP API or embedding emulator code in the server.

For CUE/GDI groups, the host supplies optional `request.media` with an `entry`
path and an approved member list. Member names are relative to the common disc
directory; absolute paths remain private to the trusted worker. The optional
`reader.readMember(name, offset, length)` reads only approved members under the
same byte/deadline budget, with at most 256 member reads. Files open lazily, and
canonical paths, regular-file identity and size/timestamps are checked around
the read. The server authorizes each member, includes every member's current
metadata in the cache key, and rechecks identity members before saving a proposal.
Unchanged single-file v3 cache keys remain valid when disc support is added.

Facts contain explicit representations and provenance:

- Verified MD5/SHA1/CRC32 facts include the byte count and representation, such as raw ROM bytes, a single archive member or a validated header-normalized payload.
- Serial/set facts carry a system hint and whether the identifier was actually read from content. A filename alias is not a verified disc ID.
- Declared container hashes remain distinct from hashes calculated by reading the logical content. Conflicting verified serials or systems require review.
- Plugin output is bounded and validated before it becomes matching input. Warning codes cannot contain paths or native stderr.

The built-in readers are JavaScript plugins with optional native adapters. They do not run emulator cores. ZIP retains its existing bounded parser. 7z uses `7zz`/`7z`; CHD uses bounded `chdman extractraw` windows. Trusted tool paths can be configured through embedded `matchingTools`, `ECS_7ZIP_PATH` and `ECS_CHDMAN_PATH`; the existing `--chdman` path is reused when supplied. Local discovery prefers maintained `7zz`. Omitted tools leave reviewable hints rather than breaking import. Native adapters run with the operator's OS privileges; output/deadline/process bounds are not an OS memory or disk sandbox.

## Current formats and cost

Raw hashing and archive expansion are capped at 64 MiB. Reads stream in bounded chunks; source identity is checked before and after work. 7z accepts one supported regular ROM member with conservative entry, compression, encryption and solid-block guards, without staging the ROM on disk. Nested archives and disc layouts are not blindly expanded. Supported format-specific header/padding normalization retains the original hash and labels the derived representation; arbitrary zero/FF trimming is never used as identity evidence.

CHD v5 first reads its header and bounded metadata. Combined CHD SHA1 can be joined to disk-catalog SHA1 as declared evidence; it is not a Redump track hash or a full logical-content verification. A configured decoder then reads small logical windows to inspect supported CD/GD track starts or ISO9660 directory records. Dreamcast/Naomi GD product IDs and PlayStation `SYSTEM.CNF` boot IDs can establish content identity. Parent-dependent images, unsupported legacy/patched layouts and ambiguous identifiers remain explicit review cases. Existing CHD download/extraction policy is unchanged; identification does not materialize an entire disc.

`org.ecs.identify.cue` and `org.ecs.identify.gdi` read uncompressed multi-file
discs through that member port. They support Dreamcast IP.BIN product IDs and
track-01 ISO9660 PlayStation/PlayStation 2 `SYSTEM.CNF` BOOT/BOOT2 serials,
including supported raw-sector layouts, CUE INDEX offsets/shared BINs and GDI
high-density track/file-offset mapping. Each identification reads at most 256 KiB
of descriptor/sectors, with a 64 KiB descriptor, 128 approved members, 99 tracks
and eight data-track limits. No audio scan, whole-disc hash or native converter
is needed. Conflicting IDs retain their evidence and block automatic matching.
Secondary CUE ISO origins remain explicit unsupported cases. Jaguar CD's generic
approved boot header does not identify a title; those sets still need a catalog
association or an explicit match. See the [CUE/GDI acceptance](cue-gdi-identification-2026-10-30.md).

RVZ and WIA identification reads the canonical first 0x80 logical disc bytes from the integrity-checked second header, following [Dolphin's format documentation](https://github.com/dolphin-emu/dolphin/blob/master/docs/WiaAndRvz.md) and `WIABlob::Read`. It validates the version/compatibility window, both header SHA1 values, declared file size, chunk/compressor fields, partition-table SHA1 and referenced metadata ranges. A six-character identifier becomes verified GC/Wii serial evidence only with the corresponding disc magic and a consistent declared disc type. No RVZ packets are decompressed and no whole-disc hash is claimed. Reading these header bytes does not verify every stored packet or establish playable compatibility.

Dolphin CISO uses its separate 0x8000-byte sparse map and stored blocks. Missing blocks read as zero; malformed maps, missing stored bytes and invalid block sizes are refused. PSP CSO uses the distinct 24-byte CISO header and indexed plain/raw-DEFLATE frames described by [PPSSPP's block reader](https://github.com/hrydgard/ppsspp/blob/master/Core/FileSystems/BlockDevices.cpp). Bounded ISO9660 traversal locates `PSP_GAME/PARAM.SFO` and reads its `DISC_ID`; directory extents must remain within the declared volume. CSOv0/v1 frames up to 64 KiB and alignment shifts up to 16 are supported. CSOv2, ZISO/LZ4, UDF and unsupported layouts remain warning-only cases.

The composable `LogicalRomReader` API provides at most 64 KiB logical windows, not a mount or conversion. PSP frames use a bounded 16-frame cache; DEFLATE output is capped at the declared frame size, with only bounded zero alignment padding accepted. The existing source identity, cancellation, total-read and worker deadline checks also apply. No native Dolphin converter is needed for these identifiers; no full image is extracted, mounted or hashed.

Use the exact maintained or patched MAME executable required by your images. The adapter does not replace its codecs or claim that upstream MAME incorporates a particular Jaguar/Flycast patch. The generic reader SPI allows a patched native library or WASM implementation to replace the decoder without weakening source or evidence checks.

## Artwork, hacks and translation patches

Artwork classification is a plugin operation with independent front, back, disc-label, manual, title-screen, screenshot and other slots. Explicit filenames/source tags identify the role; a back cover or manual does not compete with a front cover. Only one eligible front image is automatically selected. Verified identities are preferred; the explicit exact-filename fallback remains a labelled name association and cannot override an identity conflict. PDF manuals up to 8 MiB are saved/downloaded as attachments, never rendered as image previews; supported raster artwork retains its 2 MiB bound. Older clients continue receiving the primary front choice unless they request role-aware selections.

Local BPS/UPS/IPS providers retain patch type, format and base evidence. BPS/UPS can use a matching verified normalized ROM CRC/size; IPS remains an unverified association. Multiple distinct patches stay separate alternatives. Saving a hack/translation association does not apply it or distribute a patched ROM. New catalog providers should retain original game/base identity, patch revision/language, source URL, license and immutable patch digest instead of treating a hack as an unrelated official release.

## Consolidated catalog direction

Providers now reconcile compatible partial DAT/hash/serial records while retaining per-source provenance. Conflicting hashes, editions and IDs stay reviewable. A cloud catalog should build on that representation: versioned manifests, per-system metadata shards, separate cheats/patch/artwork indexes, immutable byte/hash pins and reproducible source receipts. Keeping large payloads separate lets a small metadata update avoid downloading cheats or patch binaries, and lets each source retain its license and update policy.

The [hosted catalog snapshot and updater](hosted-catalogs.md) now provide pinned
metadata, cheat and patch catalogs using this representation. Format identification
still depends on the available reader and authoritative records; publishing a
catalog does not turn an unknown disc header or a filename into verified identity.
