# Upstream build resolution evidence, 2026-11-06

All 50 retained loader/WASM pairs were rehashed successfully against the catalog pins. The existing binary-mapping report records their archive origins and embedded frontend/core self-reports. This follow-up identifies historical CI source candidates for the eleven unresolved cores and corroborates an SDK release candidate for all fifty profiles. Complete source/build mappings remain unverified for all fifty, and the same eleven exact core revisions remain unresolved.

## Historical CI candidates

Public GitLab metadata records fourteen successful October 30 Emscripten jobs across the eleven profiles. Every relevant job has an `erased_at` timestamp on November 1 or 2 and an empty artifacts list. The machine-readable report preserves pipeline/job URLs, source SHAs, timestamps, raw-response hashes, commit-pinned CI/Makefile URLs and the exact catalog resource hashes. No retained checksum manifest binds these jobs to the catalog pairs. The dated archive supplies exact bytes for all eleven profiles covered here. [Dated upstream archive](https://buildbot.libretro.com/nightly/emscripten/2026-10-31_RetroArch.7z)

| Profile | Candidate core commit | Pipeline | Emscripten job |
| --- | --- | --- | --- |
| org.libretro.snes9x2002 | `6ffbf9ef` | [129732](https://git.libretro.com/libretro/snes9x2002/-/pipelines/129732) | [2680436](https://git.libretro.com/libretro/snes9x2002/-/jobs/2680436) |
| org.libretro.beetle-pce-fast | `2de1ce1c` | [129757](https://git.libretro.com/libretro/beetle-pce-fast-libretro/-/pipelines/129757) | [2680966](https://git.libretro.com/libretro/beetle-pce-fast-libretro/-/jobs/2680966) |
| org.libretro.beetle-pce-fast | `4eee99c4` | [129729](https://git.libretro.com/libretro/beetle-pce-fast-libretro/-/pipelines/129729) | [2680334](https://git.libretro.com/libretro/beetle-pce-fast-libretro/-/jobs/2680334) |
| org.libretro.fbneo | `9d82650b` | [129568](https://git.libretro.com/libretro/FBNeo/-/pipelines/129568) | [2676660](https://git.libretro.com/libretro/FBNeo/-/jobs/2676660) |
| org.libretro.fbalpha2012-cps1 | `5542c184` | [129679](https://git.libretro.com/libretro/fbalpha2012_cps1/-/pipelines/129679) | [2679060](https://git.libretro.com/libretro/fbalpha2012_cps1/-/jobs/2679060) |
| org.libretro.fbalpha2012-cps2 | `e3f3ae46` | [129678](https://git.libretro.com/libretro/fbalpha2012_cps2/-/pipelines/129678) | [2679036](https://git.libretro.com/libretro/fbalpha2012_cps2/-/jobs/2679036) |
| org.libretro.ecwolf | `0cccd9a8` | [129700](https://git.libretro.com/libretro/ecwolf/-/pipelines/129700) | [2679586](https://git.libretro.com/libretro/ecwolf/-/jobs/2679586) |
| org.libretro.vitaquake2 | `4b333fe1` | [129591](https://git.libretro.com/libretro/vitaquake2/-/pipelines/129591) | [2677149](https://git.libretro.com/libretro/vitaquake2/-/jobs/2677149) |
| org.libretro.vba-next | `788192f2` | [129722](https://git.libretro.com/libretro/vba-next/-/pipelines/129722) | [2680157](https://git.libretro.com/libretro/vba-next/-/jobs/2680157) |
| org.libretro.gearcoleco | `063fa521` | [129819](https://git.libretro.com/libretro/gearcoleco/-/pipelines/129819) | [2682276](https://git.libretro.com/libretro/gearcoleco/-/jobs/2682276) |
| org.libretro.gearcoleco | `1938f3f8` | [129804](https://git.libretro.com/libretro/gearcoleco/-/pipelines/129804) | [2681879](https://git.libretro.com/libretro/gearcoleco/-/jobs/2681879) |
| org.libretro.gearcoleco | `ac4a5203` | [129602](https://git.libretro.com/libretro/gearcoleco/-/pipelines/129602) | [2677432](https://git.libretro.com/libretro/gearcoleco/-/jobs/2677432) |
| org.libretro.gme | `1562f620` | [129685](https://git.libretro.com/libretro/libretro-gme/-/pipelines/129685) | [2679221](https://git.libretro.com/libretro/libretro-gme/-/jobs/2679221) |
| org.libretro.minivmac | `babdf7b5` | [129668](https://git.libretro.com/libretro/libretro-minivmac/-/pipelines/129668) | [2678863](https://git.libretro.com/libretro/libretro-minivmac/-/jobs/2678863) |

### Beetle PCE Fast

The exact pinned WASM contains all 31 checked newly added UTF-8 string literals from commit `2de1ce1c3f237b161c126c54ba407990bb86d1e9`. All 29 checked removed literals are absent. These source literals favor the later October 30 candidate and exclude the earlier candidate's unmodified translation header. The JSON records the source macros, literal hashes and binary byte offsets. Complete source identity and binary-to-job provenance remain unverified. [Primary commit and patch](https://api.github.com/repos/libretro/beetle-pce-fast-libretro/commits/2de1ce1c3f237b161c126c54ba407990bb86d1e9)

### Gearcoleco

The exact WASM embeds `1.7.6` at byte offset 3347309. The currently published annotated `1.7.6` tag resolves to `063fa52151581b356f466905c74a79f9df8d19d7`. The candidate Makefile derives `EMULATOR_BUILD` using `git describe --abbrev=7 --dirty --always --tags`. This favors that candidate. Historical tag identity, complete source state and exact binary-to-job provenance remain unverified. [Annotated tag object](https://api.github.com/repos/drhelius/Gearcoleco/git/tags/2d388dbaadb23fa398fb9136f24e4230cb0f2f5d), [candidate Makefile](https://raw.githubusercontent.com/drhelius/Gearcoleco/063fa52151581b356f466905c74a79f9df8d19d7/platforms/libretro/Makefile)

## SDK release correlation

Official emsdk `3.1.46` metadata maps to emscripten-releases commit `21644188d5c473e92f1d7df2f9f60c758a78a486`. That release's dependency manifest identifies the following revisions. [SDK release metadata](https://raw.githubusercontent.com/emscripten-core/emsdk/3.1.46/emscripten-releases-tags.json), [release dependency manifest](https://chromium.googlesource.com/emscripten-releases/+/21644188d5c473e92f1d7df2f9f60c758a78a486/DEPS)

| Component | Release dependency revision |
| --- | --- |
| LLVM | `75501f53624de92aafce2f1da698b249a7293dc7` |
| Emscripten | `19607820c447a13fd8d0b7680c56148427d6e1b8` |
| Binaryen | `16a59938563c93d8459bf36679c83497aeba7cc7` |

The LLVM revision matches the compiler identity embedded in all fifty exact pinned WASM files. This corroborates the historical Dockerfile's SDK `3.1.46` candidate. The actual SDK installation, container digest and toolchains for every linked core/runtime object remain unverified. The published Linux SDK archive was inspected with HEAD only, so the JSON records its object generation and response checksum metadata while leaving its binary SHA256 unresolved. [SDK manifest](https://raw.githubusercontent.com/emscripten-core/emsdk/3.1.46/emsdk_manifest.json), [published SDK archive](https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/21644188d5c473e92f1d7df2f9f60c758a78a486/wasm-binaries.tbz2)

## Remaining inputs

Closing the full mapping for each profile still requires a retained source/build manifest or reproducible result binding its exact JS/WASM SHA256 pair to the source inputs, the actual container/SDK distribution, complete working trees and patches, submodule/dependency revisions and notices, exact compiler/linker flags and environment, precompiled frontend artifact/cache inputs, and an independent rebuild comparison.

The GitLab source-file API returned HTTP429 after six successful source-file reads. Commit-pinned public GitHub mirrors supplied the remaining CI and Makefile records. Failed responses remain in the external research directory and are excluded from successful evidence. Erased job trace endpoints were not retried.

The companion JSON carries portable upstream URLs, response SHA256 hashes, exact archive member names and binary offsets. Raw responses and detailed records remain in `/var/tmp/ecs-upstream-build-resolution-2026-11-06`, with retention hashes recorded in the JSON. This CI/SDK research produced no rebuild or new exact binary-to-job checksum match.
