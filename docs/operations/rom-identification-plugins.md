# ROM identification plugins

Identification and catalog matching are separate plugin stages. The HTTP process checks the source ACL, containment, availability and current identity. It sends a trusted local path only to the isolated reader worker. Online catalog providers receive bounded facts, never that path or ROM bytes. The shared queue owns the work; cancellation retires the worker and its native reader process group. Results persist against source identity and the reader/configuration version, so another browser or later matching pass reuses the same evidence.

## Reader contract

An offline `provider` manifest with `rom` capability may export `identify(request, reader, signal)`. Normal matching providers keep their `search` export; an identification-only provider may return no search results. See [the homebrew example](../../examples/plugins/rom-identifier/entry.mjs). Install it using the existing `--matching-plugins` directory. Restart after changing an identifier, its entry module or its native tools so the configuration fingerprint and module cache refresh together.

`reader.read(offset, length)` and `reader.stream(offset, length)` supply bounded data from one opened source. `reader.runTool` supports the configured native adapters with bounded output, deadlines and joined termination. A WASM library can implement the same JavaScript `identify` export and consume bounded windows; there is no separate unrestricted path/network ABI for a WASM identifier. CISO/RVZ/WIA readers can be added through that contract without changing the HTTP API or embedding emulator code in the server.

Facts contain explicit representations and provenance:

- Verified MD5/SHA1/CRC32 facts include the byte count and representation, such as raw ROM bytes, a single archive member or a validated header-normalized payload.
- Serial/set facts carry a system hint and whether the identifier was actually read from content. A filename alias is not a verified disc ID.
- Declared container hashes remain distinct from hashes calculated by reading the logical content. Conflicting verified serials or systems require review.
- Plugin output is bounded and validated before it becomes matching input. Warning codes cannot contain paths or native stderr.

The built-in readers are JavaScript plugins with optional native adapters. They do not run emulator cores. ZIP retains its existing bounded parser. 7z uses `7zz`/`7z`; CHD uses bounded `chdman extractraw` windows. Trusted tool paths can be configured through embedded `matchingTools`, `ECS_7ZIP_PATH` and `ECS_CHDMAN_PATH`; the existing `--chdman` path is reused when supplied. Local discovery prefers maintained `7zz`. Omitted tools leave reviewable hints rather than breaking import. Native adapters run with the operator's OS privileges; output/deadline/process bounds are not an OS memory or disk sandbox.

## Current formats and cost

Raw hashing and archive expansion are capped at 64 MiB. Reads stream in bounded chunks; source identity is checked before and after work. 7z accepts one supported regular ROM member with conservative entry, compression, encryption and solid-block guards, without staging the ROM on disk. Nested archives and disc layouts are not blindly expanded. Supported format-specific header/padding normalization retains the original hash and labels the derived representation; arbitrary zero/FF trimming is never used as identity evidence.

CHD v5 first reads its header and bounded metadata. Combined CHD SHA1 can be joined to disk-catalog SHA1 as declared evidence; it is not a Redump track hash or a full logical-content verification. A configured decoder then reads small logical windows to inspect supported CD/GD track starts or ISO9660 directory records. Dreamcast/Naomi GD product IDs and PlayStation `SYSTEM.CNF` boot IDs can establish content identity. Parent-dependent images, unsupported legacy/patched layouts and ambiguous identifiers remain explicit review cases. Existing CHD download/extraction policy is unchanged; identification does not materialize an entire disc.

Use the exact maintained or patched MAME executable required by your images. The adapter does not replace its codecs or claim that upstream MAME incorporates a particular Jaguar/Flycast patch. The generic reader SPI allows a patched native library or WASM implementation to replace the decoder without weakening source or evidence checks.

## Artwork, hacks and translation patches

Artwork classification is a plugin operation with independent front, back, disc-label, manual, title-screen, screenshot and other slots. Explicit filenames/source tags identify the role; a back cover or manual does not compete with a front cover. Only one corroborated front image is automatically selected. PDF manuals up to 8 MiB are saved/downloaded as attachments, never rendered as image previews; supported raster artwork retains its 2 MiB bound. Older clients continue receiving the primary front choice unless they request role-aware selections.

Local BPS/UPS/IPS providers retain patch type, format and base evidence. BPS/UPS can use a matching verified normalized ROM CRC/size; IPS remains an unverified association. Multiple distinct patches stay separate alternatives. Saving a hack/translation association does not apply it or distribute a patched ROM. New catalog providers should retain original game/base identity, patch revision/language, source URL, license and immutable patch digest instead of treating a hack as an unrelated official release.

## Consolidated catalog direction

Providers now reconcile compatible partial DAT/hash/serial records while retaining per-source provenance. Conflicting hashes, editions and IDs stay reviewable. A cloud catalog should build on that representation: versioned manifests, per-system metadata shards, separate cheats/patch/artwork indexes, immutable byte/hash pins and reproducible source receipts. Keeping large payloads separate lets a small metadata update avoid downloading cheats or patch binaries, and lets each source retain its license and update policy.

A hosted consolidated snapshot and its updater are not published by this batch. Current providers use bounded source caches and the new reconciliation/indexing path. This keeps distribution independent of identification support and avoids replacing traceable source evidence with an opaque monolith.
