# Browser core coverage, 2026-10-31

The upstream catalog now contains **49 pinned profiles**, up from 35. **44 are installable across 35 canonical Provenance system identifiers**. Installation availability means that the verified loader/WASM pair fits the current browser runtime; it is not a claim that a game has been tested or that the core is already installed. Profiles explicitly say experimental/startup verified and keep synchronized saves disabled.

## Fresh official inventory

The current [official web selector](https://web.libretro.com/core_list.js) lists 88 cores. A fresh download audit obtained 87 pairs within the 8 MiB loader / 64 MiB WASM limits; ScummVM exceeded the WASM cap. All 87 pairs passed factory initialization, required MEMFS/callMain export checks and a MEMFS write/read round trip in the **unchanged production opaque sandbox HTML**, with its actual strict CSP. No `unsafe-eval`, `--no-sandbox`, worker permission, external runtime network access or headed browser was used. Only `wasm-unsafe-eval` is permitted for WASM compilation. Each result reported opaque origin `null`, no page errors and no unexpected requests. Concurrency was limited to two, with headless Chromium and muted audio.

All 35 previously cataloged pairs changed since the prior snapshot. Their hashes and lengths are refreshed alongside the additions. Official artifact URLs are mutable: the installer intentionally refuses replacements that do not match these exact pins. The complete 98 artifact hashes, sizes, system/extension mappings, licenses, firmware paths and metadata provenance are in [player-catalog-upstream-data.ts](../../apps/server/src/player-catalog-upstream-data.ts). This snapshot uses immutable [libretro core-info revision 542c909](https://github.com/libretro/libretro-super/tree/542c909bc7b56705a6dc42e5323aef1762c618d9/dist/info), with a separate hash for every metadata file. Metadata/source links do not establish the compiler commits of upstream binary builds; those are unknown and must not be invented.

External receipts remain outside the repository:

- `/tmp/ecs-libretro-audit-20261031/{summary,downloads,smokes}.json`: 88 selected, 87 pairs, 87 passes; production bootstrap SHA256 `3d24095174a75d7db28e8a2dfc67f1d2e63a40bfc674c7f470234a13bba945d4`.
- `/tmp/ecs-libretro-verified-pins-20261031.json`: all 49 selected profiles, revalidated against the downloaded artifact lengths/hashes and strict startup receipts.
- `/tmp/ecs-libretro-extra-audit-20261031/{downloads,smokes,summary}.json`: 19 additional requested-system endpoints, eight downloadable legacy pairs, zero compatible factory startups.

## Additions and enabled media

| New profile | Provenance systems / enabled content | Important scope |
| --- | --- | --- |
| DoubleCherryGB | GB/GBC; GB-family cartridges | Single content; link/netplay/peripherals unverified |
| Genesis Plus GX Wide | Genesis, Master System, Game Gear, SG-1000, Sega CD | Cartridges plus complete CHD/ISO; widescreen unverified |
| Gearcoleco | ColecoVision; COL/CV/BIN/ROM/ZIP | BIOS required; ADAM disk/tape layouts excluded |
| Handy | Lynx; LNX/LYX/O | Optional real boot firmware |
| FB Alpha 2012 | Arcade/CPS-1/CPS-2/Neo Geo ZIP | Complete compatible set required; separate parent/BIOS dependencies unresolved |
| GME | Music; supported console music formats | Audio behavior unverified |
| Mini vMac | Macintosh; DSK/IMG/ZIP/HVF | ROM and bootable OS disk needed; no CMD/multidisk layout |
| Mu | Palm OS; PRC/PQA/IMG/PDB/ZIP | Matching model firmware needed; pen/touch/application boot unverified |
| NeoCD | Neo Geo CD; CHD | User BIOS staged under declared `neocd/` system subdirectory |
| O2EM | Odyssey2/Videopac; BIN | Matching model BIOS required |
| Opera | `com.provenance.3DO`; ISO/BIN/CHD | BIOS required; complete single file only |
| Vecx | Vectrex; BIN/VEC | **Unavailable**: actual WebGL rendering needs verification; upstream reports desktop OpenGL 3.3 |
| VICE x64 | C64; supported single disk/cartridge/program | Keyboard-heavy software, disk swaps and companion layouts unverified |
| VICE xscpu64 | C64 SuperCPU; same bounded single-file set | SuperCPU behavior unverified |

Existing Genesis Plus GX, PicoDrive and ClownMDEmu profiles now also map Sega CD with complete CHD/ISO content. Geargrafx and Beetle PCE Fast map PC Engine CD with CHD. Nestopia maps FDS with FDS content. These extensions are present in the pinned official core-info; no CUE/CCD/GDI/TOC/M3U companion descriptor is advertised by these profiles. The ordinary runtime remains capped at 512 MiB for complete staged content. A larger uncompressed image needs conversion to a supported complete compressed image within that limit or a future large-file host for that core.

Four existing engine profiles remain unavailable: PrBoom needs engine data, ECWolf needs PK3 plus companion content, TyrQuake needs the `id1/` layout, and vitaQuake2 needs verified game-data folders. Thirty-eight other successful factories were not added: they are duplicate upstream FCEUmm, optional game engines, no-content applications, or platforms without a canonical Provenance mapping in this batch. C128/PET/VIC-20 are not mislabeled C64; PC-88 is not mislabeled PC-98.

## Owner-supplied firmware

No BIOS, ROM, NAND, save or operating-system disk was downloaded or committed. The catalog descriptions specify the important firmware requirements; all upstream-reported firmware paths are retained in the typed pin data. Core-info marks some files optional because a choice of models is possible; that does not mean a BIOS-dependent machine can boot with no appropriate BIOS at all.

| System/core | User-managed filename(s) / placement |
| --- | --- |
| ColecoVision / Gearcoleco | `colecovision.rom`; ADAM `eos.rom`/`writer.rom` layouts are outside this profile |
| Odyssey2 / O2EM | `o2rom.bin`; model alternatives `c52.bin`, `g7400.bin`, `jopac.bin` |
| 3DO / Opera | A compatible BIOS such as `panafz1.bin` or `panafz10.bin`; other official model names are in the data |
| Macintosh / Mini vMac | `MacII.ROM` plus a separately supplied bootable disk |
| Palm OS / Mu | Default m515: `palmos41-en-m515.rom`; other models use their matching ROM |
| Neo Geo CD / NeoCD | For example `neocd_f.rom`, `neocd_t.rom`, `neocd_z.rom`, or another supported BIOS; metadata declares `systemFilesDirectory: 'neocd'`, so the host stages basenames below `/ecs/system/neocd/` while keeping RetroArch's system root `/ecs/system` |
| Sega CD | Regional `bios_CD_U.bin`, `bios_CD_E.bin`, `bios_CD_J.bin` |
| PC Engine CD | `syscard3.pce` |
| FDS | `disksys.rom` |
| Lynx / Handy | Optional `lynxboot.img` |

## Original-program rendering evidence

An entirely original public-domain NES program from `examples/browser-playback/acceptance.s` was assembled outside the repository. The broad rendering probe uses a deterministic zero-page counter variant (`$6000`→`$0002`, `$6001`→`$0003`) so it does not assume SRAM behavior. FCEUmm, Nestopia and QuickNES all executed it and produced its blue palette output through production `main`, `display-info` and `screenshot` RPCs in the unchanged opaque sandbox. Captured center pixels were `[60,190,255,255]`, `[75,159,255,255]`, `[99,178,255,255]`, respectively. All three had zero browser errors and unexpected requests. Receipt: `/tmp/ecs-libretro-homebrew-20261031-v3/smokes.json`; generated source and binary stay alongside it outside the repository.

The original SRAM-dependent fixture produced white output in QuickNES, so this batch does not establish QuickNES battery RAM/saves. No save claim was added. No firmware-dependent core or commercial game received a content-compatibility claim from a factory test.

The extra official endpoint probe found legacy non-ESM loaders for Stella, Stella2014, FreeIntv, fMSX, blueMSX, Caprice32, Fuse and Beetle PC-FX. All failed the production factory contract and were excluded. Atari800, PokeMini, gpSP, SameBoy, SameDuck, DeSmuME, melonDS, DOSBox Pure, Beetle SuperGrafx/Saturn/PSX endpoints did not provide a complete pair in that probe. Existing source-built PSX/FCEUmm/ProSystem/Jaguar profiles remain the appropriate separate routes; existing Flycast/Dolphin work is not replaced by these upstream pairs.

## One central source buildbot and immutable hosting

[The manual workflow](../../.github/workflows/browser-cores.yml) uses this repository as the central build/hosting location. It defaults to artifacts only. Its data-driven [configuration](../../scripts/browser-core/buildbot-config.json) selects existing FCEUmm, ProSystem, PCSX ReARMed or firmware-free Virtual Jaguar recipes, limits compilation to two workers and keeps source checkouts/artifacts outside the repository. No external repository or release was created by this batch. Flycast and Dolphin are deliberately absent from publication choices while distribution/source audits remain unresolved.

| Input | Immutable revision |
| --- | --- |
| RetroArch | `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66` |
| FCEUmm | `ac0d00a7fc01166f84c7bac01d1084ebfd2b865e` |
| ProSystem | `8a88014287c7a01cd568067e5a557d0a2b2a051f` |
| PCSX ReARMed | `c8816799b50388e61cfe237fe2cdbb7d8175f20a` |
| Virtual Jaguar | `ffea7893a59dd9b9e6f9b85c51627810338b0778` |
| emsdk repository | `93360d3670018769b424e4e8f1d3d9b26d32c977` |
| Emscripten compiler 3.1.46 | `19607820c447a13fd8d0b7680c56148427d6e1b8` |

The SDK and compiler revisions are different repositories. The cached installed toolchain confirmed both exact values. The outer build receipt records and checks the compiler's actual version/commit instead of treating the emsdk checkout as the compiler commit.

Each successful job packages `.ecsplayer`, manifest, SHA256/size catalog, startup receipt, complete corresponding frontend/core source, required tracked patches/rebuild scripts, and notices. Git archives contain committed source only. FCEUmm's frontend snapshot receives the tracked SAVE_FILES patch before archiving; its standalone rebuild helper includes exact frontend/core flags. PCSX ReARMed's native-only `frontend/libpicofe` gitlink is not used by the libretro Emscripten target (the existing immutable-source recipe builds without it); no needed libretro target source is replaced by uninitialized submodules. Jaguar uses its existing sanitizer/archive recipe, removing firmware arrays before compilation and source packaging; its original firmware-bearing Git tree is not archived.

`verify_rebuild` optionally performs a second build from the packaged source and compares both artifact hashes. Requesting `publish_release` **always forces this verification** even if the standalone checkbox is false. The separate publication job also checks the reproducibility receipt, rejects existing tags/releases and uploads the complete package/source/notices set to a new `browser-core-*` **prerelease with `--latest=false`**. Ordinary builds have read-only repository permissions; only the explicitly requested publication job receives write permission. Upstream mutable binaries are not rehosted as if these source recipes reproduced them.

The new workflow/driver received focused tests and static validation; no full source compile, workflow dispatch or release was performed locally in this batch. Existing recipes have prior core acceptance evidence. A first manual dispatch is still required to establish the new Linux workflow's end-to-end build/source reproduction result. Publication fails closed if a packaged-source rebuild differs.

To repeat the fresh strict inventory, run `node scripts/browser-core/audit-libretro-web.mjs --output=NEW_EXTERNAL_DIRECTORY` (optional `--cores=name,name`). After building the server package, `refresh-upstream-pins.mjs AUDIT_DIRECTORY YYYY-MM-DD NEW_JSON_SNAPSHOT` rechecks every selected artifact against startup receipts and file hashes without overwriting existing snapshots. Review the resulting data before updating the catalog; do not substitute legacy scripts or relax the sandbox to increase the count.
