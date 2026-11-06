# Official upstream binary mapping evidence, 2026-11-06

All 50 pinned loader/WASM pairs were rehashed and inspected. The October 31 dated upstream archive supplies 49 exact pairs. The separately retained November 4 PCSX download supplies the final exact pair.

The exact WASM bytes self-report frontend revisions for all 50 profiles and core revisions for 39 profiles. Those abbreviated revisions resolved through primary repository commit APIs. Eleven core revisions remain unresolved. All 50 embed the same Clang 18.0.0 / LLVM 75501f53624de92aafce2f1da698b249a7293dc7 identity. Complete source/build mappings remain unverified for all 50.

The historical primary Dockerfile pins Emscripten 3.1.46, and the CI template uses a mutable latest container tag, precompiled frontend artifacts, and caches. These records provide build context. They do not bind an SDK/container revision, clean source state, complete flags, patches, source archives or notices to every pinned binary.

| Profile | Frontend self-report | Core self-report | Resolved core commit |
| --- | --- | --- | --- |
| org.libretro.pcsx-rearmed | `1460bf0` | `r26 7b0e8f8` | `7b0e8f8fadfbce3d170d195b9d9eecaabfa08c8e` |
| org.libretro.gearboy | `376110a` | `3.8.20-1-g17e680c` | `17e680cc0f63fcbfbf69d62e773fd4efca6204a2` |
| org.libretro.gambatte | `400d7ed` | `v0.5.0 77f2567` | `77f2567d718b8973d02caa2daa8dce4953faf811` |
| org.libretro.tgbdual | `6ebf66b` | `v0.8.3 0392c9c` | `0392c9c469e653205e471114c7949c07c83bfce9` |
| org.libretro.mgba | `6ebf66b` | `0.11-212-7a12d6d` | `7a12d6d4b9acb14c0ae62c9166b6a2f3d08007f6` |
| org.libretro.nestopia | `376110a` | `2.0.0 ad2e741` | `ad2e7419b00c0c7c16267f6f328a542fccfed335` |
| org.libretro.quicknes | `6ebf66b` | `1.0-WIP 26bb785` | `26bb785c9deddb66a17717b21bb4e328f03ade32` |
| org.libretro.gearsystem | `376110a` | `3.9.24-1-g54ab207` | `54ab207abf3db2dc2822b7df20df640eaffad504` |
| org.libretro.clownmdemu | `6ebf66b` | `v1.6.12 d43c270` | `d43c2708b0a31c285ce16724b6c4a2e92af07346` |
| org.libretro.genesis-plus-gx | `e09402e` | `v1.7.4 f27655b` | `f27655b592ef43f317272d79883bcaa10d3ac8ad` |
| org.libretro.picodrive | `6ebf66b` | `2.05-1890c29` | `1890c2932234c9d30f4cd3851d02228baae8f09e` |
| org.libretro.snes9x | `6ebf66b` | `1.63 fae2fea` | `fae2fea08f74180759ef540ee94259213f503480` |
| org.libretro.snes9x2002 | `6ebf66b` | unresolved | unresolved |
| org.libretro.snes9x2005 | `6ebf66b` | `v1.36 a79dfe9` | `a79dfe9047e7fec58808aefe48ad2bf499c7af11` |
| org.libretro.snes9x2010 | `6ebf66b` | `1.52.4 fe690dd` | `fe690dd321fa5a46b5234a2bde089d2518c62b0e` |
| org.libretro.geargrafx | `376110a` | `1.8.6-1-g13997bf` | `13997bf9ff7adfa53b1b0079a301892d0d40917b` |
| org.libretro.beetle-pce-fast | `400d7ed` | unresolved | unresolved |
| org.libretro.beetle-lynx | `6ebf66b` | `v1.24.0 fcdefcf` | `fcdefcfb3c11d6d2e71be076a5d3df2e88ab73ed` |
| org.libretro.beetle-ngp | `6ebf66b` | `v1.29.0.0 a50d5ac` | `a50d5ac288a81f2104ddf43195a4efdd15c72227` |
| org.libretro.beetle-wswan | `6ebf66b` | `v0.9.35.1 4b01295` | `4b01295838ea89e3f1355bbe4cb5cf98aa6108cd` |
| org.libretro.beetle-vb | `6ebf66b` | `v1.31.0 d5ae54c` | `d5ae54c8e23b573a3b34e888b2d48a588027e92c` |
| org.libretro.tia | `6ebf66b` | `20+6ae5bf9` | `6ae5bf998fe7a7842294089db17fc86fd73db1f0` |
| org.libretro.mame2000 | `6ebf66b` | `0.37b5 181b42e` | `181b42e5da0d2f0c7a2e59244f23633ed594de2e` |
| org.libretro.mame2003 | `6ebf66b` | `0.78 b9ac708` | `b9ac708f922386a0ae1f2379dbb31b60d7ec7b25` |
| org.libretro.mame2003-plus | `e2d7b0b` | ` df60f64` | `df60f6466d678f38bcb978d73983c9c7ed2cba6e` |
| org.libretro.fbneo | `6ebf66b` | unresolved | unresolved |
| org.libretro.fbalpha2012-cps1 | `6ebf66b` | unresolved | unresolved |
| org.libretro.fbalpha2012-cps2 | `6ebf66b` | unresolved | unresolved |
| org.libretro.fbalpha2012-neogeo | `6ebf66b` | `v0.2.97.29 e092097` | `e092097037d494c50d17c5144a2758d68538061b` |
| org.libretro.prboom | `6ebf66b` | `v2.5.0 4849268` | `4849268e7342494193f2bbf2d0128a751cf58da7` |
| org.libretro.ecwolf | `6ebf66b` | unresolved | unresolved |
| org.libretro.tyrquake | `6ebf66b` | `v0.62 67db338` | `67db338ff4d27fdbcead61d4e54938d758ae62cb` |
| org.libretro.vitaquake2 | `6ebf66b` | unresolved | unresolved |
| org.libretro.tic80 | `6ebf66b` | `1.2.50-dev (ae1195a)` | `ae1195a9d0fbda243bf0ebd861d6876d072a979e` |
| org.libretro.vba-next | `6ebf66b` | unresolved | unresolved |
| org.libretro.vice-x64sc | `770391e` | `3.10 5ebe7d3` | `5ebe7d333ab15be57a9dde5f46c29a5bbd5f44f8` |
| org.libretro.doublecherrygb | `6ebf66b` | `v0.19.0 d432f97` | `d432f97693670524f7f46bfca886b731134f4bb6` |
| org.libretro.genesis-plus-gx-wide | `6ebf66b` | `v1.7.4 b7ad005` | `b7ad005431f5f0b55e559f6d598d1ed2479bf13b` |
| org.libretro.gearcoleco | `376110a` | unresolved | unresolved |
| org.libretro.handy | `6ebf66b` | `0.97 bc55d46` | `bc55d462f0b2d6b073ea93dc552ebd73cec60fd1` |
| org.libretro.fbalpha2012 | `6ebf66b` | `v0.2.97.29 0ce3153` | `0ce31536bef3162fe7e69ff5f555334ec4913cef` |
| org.libretro.gme | `6ebf66b` | unresolved | unresolved |
| org.libretro.minivmac | `6ebf66b` | unresolved | unresolved |
| org.libretro.mu | `6ebf66b` | `v1.3.3 afaeb15` | `afaeb157b8ba38a4a9bdf426ba663f7efb2cc6f8` |
| org.libretro.neocd | `6ebf66b` | `2022 b1e04c7` | `b1e04c738cb48a1dae0574b8877f6a116d270ca1` |
| org.libretro.o2em | `6ebf66b` | `1.18 679d6fe` | `679d6fec04963f6e70a7ec217e3d0ebb1fe472fc` |
| org.libretro.opera | `2edc4a9` | `1.0.0 370d9a2` | `370d9a25c030bb9de4aade371b31045691c40a95` |
| org.libretro.vecx | `6ebf66b` | `1.2 dccff54` | `dccff5402a16d1ea7c112095a8e42632bf149506` |
| org.libretro.vice-x64 | `770391e` | `3.10 5ebe7d3` | `5ebe7d333ab15be57a9dde5f46c29a5bbd5f44f8` |
| org.libretro.vice-xscpu64 | `770391e` | `3.10 5ebe7d3` | `5ebe7d333ab15be57a9dde5f46c29a5bbd5f44f8` |
