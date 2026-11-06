# Component notice audit, 2026-11-06

The [modern component matrix](./component-notice-audit-2026-11-06.json) records 43
overlapping source-component scopes across the eight reproduced modern builds.
The [legacy matrix](./legacy-component-notices-2026-11-06.json) adds 15 scopes and
exact-content matches to shared frontend components. Input indexes reference the
hashed compiler inventories. Each notice retains exact file or byte-span hashes.

## Material findings

- Atari800 compiles Caprice32-derived utilities with noncommercial terms, source
  redistribution conditions and documentation notice requirements.
- Potator compiles M65C02 code whose banner prohibits commercial distribution and
  requests notification of modifications. Its broad Unlicense declaration leaves
  those incorporated terms to their narrower scope.
- Frontend and core NTSC filters carry LGPL 2.1-or-later grants. POKEY/TIA routines
  carry GNU Library GPL version 2 notices. Full version 2.0 and 2.1 license-text
  references are pinned alongside their source-specific attribution records.
- dr_flac and stb_image grants occur beyond the earlier 64 KiB scan. Full-file
  scanning now retains them. Adjacent comment blocks stay grouped so split banners
  retain their distribution conditions.
- Bundled Atari zlib 1.2.7/1.2.8, PCFX zlib 1.2.11, and SDK zlib 1.2.13 retain
  distinct notice scopes. PCFX and Jaguar also use distinct codec versions.
- Nested libchdr, LZMA, Zstandard, miniz, Tremor, RSA MD5, CoreTone, Altirra, tracker,
  image decoding, JSON and other incorporated notices have individual records.
  PCFX's V810 source offers its historical terms as an alternative to GPL 2+.
- The original bcdec 0.97 MIT/Unlicense grant is pinned to its historical upstream
  commit. FCEUmm's PIC16C5x BSD-3-Clause identifier and attribution are paired with
  the full standardized grant text. FCEUmm MD5's GPL-version interpretation uses
  the surrounding project's GPL 2+ context, as recorded in the matrix.

## Legacy reconstruction and input closure

FCEUmm and Jaguar were rebuilt from fresh verified archives with compiler dependency
capture. Both loader/WASM pairs match published bytes. FCEUmm produced 806 compiler
invocations and Jaguar 378, with zero failures or unresolved dependency paths.
Their [inventory](./legacy-build-notices-2026-11-06.json) retains 2,714 distinct
inputs. The [receipt](./legacy-build-verification-2026-11-06.json) records every
project input's archive comparison, including the independently reconstructed
FCEUmm save.c patch result. Helpers used the SDK's Node 16.20 and collection used
Node 22.22.2. The collector's symlinked CLI entry point has a regression test.

## SDK link selection

The [SDK link evidence](./sdk-link-notices-2026-11-06.json) records exact linker
replays for all ten custom builds. Output basenames were preserved because they
enter the WASM name section. Every replay matches its original pre-postlink WASM.
Link traces identify 335 distinct selected members across nine SDK archives,
including whole-archive fetch input. Member bytes and source candidates from the
pinned SDK recipes are retained. The complete member-name sets were checked
against those recipes. SDK source bytes match the pinned Emscripten Git tree.

The report also retains 178 modern input records with newly captured notice spans
from full-file scanning and adjacent-comment grouping. Actual input reads remain
bounded to 64 MiB. Contained notice symlinks are inspected and out-of-scope targets
become explicit gaps. Named pipes fail through nonblocking regular-file checks.

## Open evidence

PCFX's IJG inverse-DCT source points to an absent historical README. The shared
frontend SHA1 block retains a Paul E. Jones attribution whose incorporated grant
provenance remains unresolved. These questions have individual matrix entries.

Compiler participation and archive selection precede conditional-code and linker
elimination. SDK source candidates come from pinned build recipes. Independent SDK
archive reconstruction and complete final-code notice applicability remain open.
The catalog links this evidence and exposes the restrictive component terms.
