# Upstream runtime reconstructions, 2026-11-06

47 additional pinned upstream runtime pairs were independently reproduced byte-for-byte. Together with the previous VecX result, 48 of 50 now have executable reconstructions. All 49 additional profiles have completed probes.

Every exact result matches both JS/WASM SHA256 hashes and sizes and passes direct byte comparison against the retained original pair. Each core is rebuilt from pinned archives and linked against frontend objects from the pinned revision and options. Local reuse retains original object hashes and compiler traces. The Linux FBNeo attempt freshly compiles all 335 frontend objects with source/header snapshots and output hashes.

The shared Emscripten 3.1.46 inventory records 8,097 installed SDK files. Compiler dependency capture identifies source archive matches and generated differences. The serialized local queue and Linux FBNeo runner each use two make jobs and two Emscripten/Binaryen workers. Verification covers compiler inputs and exact runtime file bytes.

| Profile | Result | Core revision |
| --- | --- | --- |
| org.libretro.beetle-lynx | exact-runtime-pair-reproduced | `fcdefcfb3c11d6d2e71be076a5d3df2e88ab73ed` |
| org.libretro.beetle-ngp | exact-runtime-pair-reproduced | `a50d5ac288a81f2104ddf43195a4efdd15c72227` |
| org.libretro.beetle-pce-fast | exact-runtime-pair-reproduced | `2de1ce1c3f237b161c126c54ba407990bb86d1e9` |
| org.libretro.beetle-vb | exact-runtime-pair-reproduced | `d5ae54c8e23b573a3b34e888b2d48a588027e92c` |
| org.libretro.beetle-wswan | exact-runtime-pair-reproduced | `4b01295838ea89e3f1355bbe4cb5cf98aa6108cd` |
| org.libretro.clownmdemu | exact-runtime-pair-reproduced | `d43c2708b0a31c285ce16724b6c4a2e92af07346` |
| org.libretro.doublecherrygb | exact-runtime-pair-reproduced | `d432f97693670524f7f46bfca886b731134f4bb6` |
| org.libretro.ecwolf | exact-runtime-pair-reproduced | `0cccd9a85d7ffa33fb695691a8a5db246606518c` |
| org.libretro.fbalpha2012 | exact-runtime-pair-reproduced | `0ce31536bef3162fe7e69ff5f555334ec4913cef` |
| org.libretro.fbalpha2012-cps1 | exact-runtime-pair-reproduced | `5542c1848ef81e92db311193b01dc349bc29d7cc` |
| org.libretro.fbalpha2012-cps2 | exact-runtime-pair-reproduced | `e3f3ae46f120228b74d41e2b2862f1fbf1d7eb5b` |
| org.libretro.fbalpha2012-neogeo | exact-runtime-pair-reproduced | `e092097037d494c50d17c5144a2758d68538061b` |
| org.libretro.fbneo | built-pair-mismatch | `9d82650bb9591966987a4c36ae8a1409ce0d5d68` |
| org.libretro.gambatte | exact-runtime-pair-reproduced | `77f2567d718b8973d02caa2daa8dce4953faf811` |
| org.libretro.gearboy | exact-runtime-pair-reproduced | `17e680cc0f63fcbfbf69d62e773fd4efca6204a2` |
| org.libretro.gearcoleco | exact-runtime-pair-reproduced | `063fa52151581b356f466905c74a79f9df8d19d7` |
| org.libretro.geargrafx | exact-runtime-pair-reproduced | `13997bf9ff7adfa53b1b0079a301892d0d40917b` |
| org.libretro.gearsystem | exact-runtime-pair-reproduced | `54ab207abf3db2dc2822b7df20df640eaffad504` |
| org.libretro.genesis-plus-gx | exact-runtime-pair-reproduced | `f27655b592ef43f317272d79883bcaa10d3ac8ad` |
| org.libretro.genesis-plus-gx-wide | exact-runtime-pair-reproduced | `b7ad005431f5f0b55e559f6d598d1ed2479bf13b` |
| org.libretro.gme | exact-runtime-pair-reproduced | `1562f6207a066e9807243c89648d1cb44e411971` |
| org.libretro.handy | exact-runtime-pair-reproduced | `bc55d462f0b2d6b073ea93dc552ebd73cec60fd1` |
| org.libretro.mame2000 | exact-runtime-pair-reproduced | `181b42e5da0d2f0c7a2e59244f23633ed594de2e` |
| org.libretro.mame2003 | exact-runtime-pair-reproduced | `b9ac708f922386a0ae1f2379dbb31b60d7ec7b25` |
| org.libretro.mame2003-plus | exact-runtime-pair-reproduced | `df60f6466d678f38bcb978d73983c9c7ed2cba6e` |
| org.libretro.mgba | exact-runtime-pair-reproduced | `7a12d6d4b9acb14c0ae62c9166b6a2f3d08007f6` |
| org.libretro.minivmac | exact-runtime-pair-reproduced | `babdf7b53d361a7225858b68a8a64efe8b06f5e5` |
| org.libretro.mu | exact-runtime-pair-reproduced | `afaeb157b8ba38a4a9bdf426ba663f7efb2cc6f8` |
| org.libretro.neocd | exact-runtime-pair-reproduced | `b1e04c738cb48a1dae0574b8877f6a116d270ca1` |
| org.libretro.nestopia | exact-runtime-pair-reproduced | `ad2e7419b00c0c7c16267f6f328a542fccfed335` |
| org.libretro.o2em | exact-runtime-pair-reproduced | `679d6fec04963f6e70a7ec217e3d0ebb1fe472fc` |
| org.libretro.opera | exact-runtime-pair-reproduced | `370d9a25c030bb9de4aade371b31045691c40a95` |
| org.libretro.pcsx-rearmed | exact-runtime-pair-reproduced | `7b0e8f8fadfbce3d170d195b9d9eecaabfa08c8e` |
| org.libretro.picodrive | exact-runtime-pair-reproduced | `1890c2932234c9d30f4cd3851d02228baae8f09e` |
| org.libretro.prboom | exact-runtime-pair-reproduced | `4849268e7342494193f2bbf2d0128a751cf58da7` |
| org.libretro.quicknes | exact-runtime-pair-reproduced | `26bb785c9deddb66a17717b21bb4e328f03ade32` |
| org.libretro.snes9x | exact-runtime-pair-reproduced | `fae2fea08f74180759ef540ee94259213f503480` |
| org.libretro.snes9x2002 | exact-runtime-pair-reproduced | `6ffbf9ef4f0063e1f1b78a40d10c50fc52f2524c` |
| org.libretro.snes9x2005 | exact-runtime-pair-reproduced | `a79dfe9047e7fec58808aefe48ad2bf499c7af11` |
| org.libretro.snes9x2010 | exact-runtime-pair-reproduced | `fe690dd321fa5a46b5234a2bde089d2518c62b0e` |
| org.libretro.tgbdual | exact-runtime-pair-reproduced | `0392c9c469e653205e471114c7949c07c83bfce9` |
| org.libretro.tia | exact-runtime-pair-reproduced | `6ae5bf998fe7a7842294089db17fc86fd73db1f0` |
| org.libretro.tic80 | exact-runtime-pair-reproduced | `ae1195a9d0fbda243bf0ebd861d6876d072a979e` |
| org.libretro.tyrquake | exact-runtime-pair-reproduced | `67db338ff4d27fdbcead61d4e54938d758ae62cb` |
| org.libretro.vba-next | exact-runtime-pair-reproduced | `788192f215ad0a1413f1625b40ebba3423fa0ade` |
| org.libretro.vice-x64 | exact-runtime-pair-reproduced | `5ebe7d333ab15be57a9dde5f46c29a5bbd5f44f8` |
| org.libretro.vice-x64sc | exact-runtime-pair-reproduced | `5ebe7d333ab15be57a9dde5f46c29a5bbd5f44f8` |
| org.libretro.vice-xscpu64 | exact-runtime-pair-reproduced | `5ebe7d333ab15be57a9dde5f46c29a5bbd5f44f8` |
| org.libretro.vitaquake2 | built-pair-mismatch | `4b333fe18e8816974f04432af01f87654ae16e21` |

The JSON records source archive URLs and hashes, complete commands, compiler dependency hashes, shared frontend object hashes, SDK inventory retention hashes and both original/output resource hashes. The external directory also retains the reproducible driver, complete compiler captures, build logs, core libraries and local output binaries.

FBNeo runtime comparison executes on the Linux runner against hash-verified original archive members. Local audit verifies the runner receipt and command-log pins, every captured source/header snapshot and their pinned-archive classification. The final verification receipt separates local retained runtime comparisons from the remote comparison.

External evidence is retained at `/private/var/tmp/ecs-upstream-reconstructions-2026-11-06`.

An experimental formatter damaged four external audit drivers during this batch. Their original bytes were recovered from retained tool edits and verified against pre-format hashes and sizes. Stable formatting passed an AST-equivalence check. A fresh QuickNES repeat reproduced the earlier commands and both runtime files. Independent review verified the recovery chain. The JSON retains the original, damaged and recovered driver evidence.

Exact source/input recipes leave the historical CI job/container identity, independent SDK reconstruction and complete final-code notice mapping unresolved. All 50 catalog entries retain `sourceMapping: unverified`.

VitaQuake2 reproduces the exact JS file. Its reconstructed WASM is 4,546,370 bytes against the pinned 4,546,368 bytes. Four bounded relinks and a fresh Linux core/frontend build reproduce the same mismatching hash. A source-backed cached-archive-order experiment preserves all 167 object bytes while moving 15 codec members, and both resulting files differ from the originals. Historical link input order and cache identity remain unresolved. An exact WASM reconstruction remains open.

FBNeo completes two fresh Linux core/frontend builds with 1,468 captured compiler outputs per attempt, comprising 1,118 core objects, 335 frontend objects and 15 SDK zlib port objects. The metadata retry supplies the exact original Git version and date. Both attempts retain identical source/header inputs and all output object hashes except core libretro.o. Its JS hash still differs at the original 272,115-byte size, and its latest WASM is 42,222,475 bytes against the pinned 42,222,119 bytes. An exact pair reconstruction remains open.
