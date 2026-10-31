# Source-built Atari and Intellivision cores, 2026-10-31

Three additional profiles are now installable from this repository's central
browser-core buildbot. The buildbot supports seven source recipes in total.
The [machine-readable receipt](browser-source-cores-2026-10-31.json) records
source revisions, successful workflow runs, package/source hashes and sizes.

The local service was updated and all three profiles installed through its
normal owner API. It now has 36 installed profiles declaring 47 system IDs;
this includes existing operator-local experimental profiles, not 47 qualified
commercial-game platforms. All prior 33 profiles, the default emulator,
settings and all 807 saved match-choice rows were preserved exactly. Health
passed and no library jobs were active after installation. Private backups and
deployment receipts remain outside Git in `dist-release/atari-intellivision-20261031/`.

| Profile | Public release | Verified behavior |
| --- | --- | --- |
| Stella 2014 / Atari 2600 | [Release](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/browser-core-stella2014-2026.10.31.1) | Original 4 KiB cartridge executes and renders blue |
| Atari800 / Atari 5200 | [Release](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/browser-core-atari800-2026.10.31.1) | Original 32 KiB `.a52` cartridge executes and renders blue with the included open-source Altirra OS replacement |
| FreeIntv / Intellivision | [Release](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/browser-core-freeintv-2026.10.31.1) | Factory initialization and MEMFS read/write; game boot still requires owner-supplied `exec.bin` and `grom.bin` |

All three cloud jobs built with pinned Emscripten 3.1.46, initialized in the
production opaque sandbox and rebuilt byte-identical loader/WASM pairs from
their packaged corresponding source before publication. Independently downloaded
public packages passed checksum, manifest and resource validation. A separate
macOS Stella build also matched the Linux public loader/WASM hashes exactly.

Rendering probes used the unchanged production sandbox, opaque origin `null`,
its normal CSP, a private MessagePort and the actual emulator `main`,
`display-info` and screenshot operations. Audio was disabled before `main`;
Chromium ran headless with `--mute-audio`. No native browser was opened or
focused. Each probe had zero page errors and unexpected requests; pages and
the temporary HTTP server closed afterward.

The entirely original cartridge generators are
[`generate-2600-smoke.mjs`](../../scripts/browser-core/generate-2600-smoke.mjs)
and [`generate-5200-smoke.mjs`](../../scripts/browser-core/generate-5200-smoke.mjs).
Only the generating source is tracked. The existing upstream TIA core also
passed the original Atari 2600 rendering probe. Observed center pixels were
TIA `[66,72,200,255]`, Stella `[66,73,206,255]`, Atari800 `[74,65,173,255]`.
These are rendering checks, not commercial-game, input, audio or save qualification.

The first published build receipts report factory/MEMFS startup only; the
separate local rendering probes establish the video results above. Future
Stella/Atari800 buildbot runs additionally generate and run these original
cartridges before packaging completes.

## Shared software-core recipe

[`build-software-core.mjs`](../../scripts/browser-core/build-software-core.mjs)
uses a small allowlisted definition in the central buildbot configuration,
committed source snapshots, explicit Git version strings, two compiler workers,
software rendering, MEMFS and no pthread/audio worklet/JSPI dependency. It
includes a standalone corresponding-source rebuild helper. Existing specialized
FCEUmm, ProSystem, PCSX and Jaguar recipes remain separate.

No proprietary BIOS or game was a build input. Atari800 contains upstream's
permissively licensed Altirra replacement OS arrays with their notices retained
in corresponding source. Real optional `5200.rom` firmware can be uploaded using
the existing BIOS/support-file picker. FreeIntv firmware is required and is not
distributed. All three profiles cap cartridge content at 1 MiB and keep
synchronized saves disabled.

Use `.a52` for unknown raw Atari 5200 cartridges: the upstream core treats
unknown `.bin`/`.rom` files as Atari computer content unless recognized by its
cartridge database or configured otherwise. Cartridge header compatibility and
controller/keypad behavior need further game testing. Existing browser-core
coverage and its remaining blockers are documented in
[the upstream inventory](browser-core-coverage-2026-10-31.md).
