# More source-built systems and deferred fixes, 2026-10-31

The central buildbot now supports eleven pinned source recipes. Four additional
systems are installable from reproducible releases in this repository:

| Core / system | Release | Qualification |
| --- | --- | --- |
| PokeMini / Pokémon Mini | [Release](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/browser-core-pokemini-2026.10.31.1) | Production factory/MEMFS startup; uses upstream's original open-source FreeBIOS |
| Potator / Watara Supervision | [Release](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/browser-core-potator-2026.10.31.1) | Production startup plus original cartridge execution and video |
| SameDuck / Mega Duck | [Release](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/browser-core-sameduck-2026.10.31.1) | Production factory/MEMFS startup |
| Beetle PC-FX / PC-FX | [Release](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/browser-core-mednafen-pcfx-2026.10.31.1) | Production factory/MEMFS startup; CHD decoder compiled, complete CHD files up to 512 MiB; owner-supplied `pcfx.rom` required for disc boot |

Every successful publication rebuilt its packaged corresponding source into
byte-identical loader/WASM files. Independently downloaded public packages also
passed checksum, manifest and resource validation. Exact source revisions,
compiler pins, workflow runs and package/source hashes are in the
[receipt](browser-more-systems-2026-10-31.json). Recipes select the real nested
libretro Makefile and artifact target; PokeMini and SameDuck explicitly select
their respective static archive modes. Initial failed link attempts did not
publish packages.

The entirely original Supervision generator initializes a 160-pixel viewport,
fills VRAM with shade 1 using the emulated CPU, and increments a RAM counter.
With the test-only blue palette, the captured center was `[0,97,173,255]`, distinct
from reset VRAM's bright shade 0. Its acceptance waits for the expected shade,
with four-channel tolerance 4, rather than accepting a merely initialized frame.
Future Potator buildbot runs include this generated cartridge test. The first
published receipt records startup only; the separate local rendering receipt
establishes cartridge execution. No ROM binary is tracked.

## Atari 5200 raw cartridge fix

The [Atari800 1.1.0 release](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/browser-core-atari800-2026.10.31.2)
fixes unknown raw `.bin`/`.rom` cartridges being treated as Atari computer ROMs.
The same generated cartridge rendered as `.a52` but failed under `.bin` before
the fix. Selecting the 5200 machine alone was insufficient: upstream's raw
cartridge classification still constructed computer cartridge arguments.

The small tracked source patch honors an explicit 5200 choice during raw
cartridge classification, before choosing the cartridge type. Other machine
choices retain upstream behavior. Patched source, the patch and rebuild helpers
are included in the corresponding-source archive. The public release passed
raw `.bin` rendering in its build job, a byte-identical archive rebuild, and
independent local rendering. Center pixel: `[74,65,173,255]`; zero page errors
or unexpected requests.

Plugins can now declare optional `player.web.defaultCoreOptions`, for example:

```json
{ "defaultCoreOptions": { "atari800_system": "5200" } }
```

This is RetroArch configuration data: at most 64 safe string entries, validated
at the manifest, HTTP-client and browser boundaries. Prototype names, controls,
quotes, backslashes, pipes and surrounding whitespace are rejected. Defaults
are written to the bounded core-options file before emulator startup; remembered
user choices override them. Default changes alone preserve the existing
per-build preference identity. No new runtime permissions or executable plugin
imports are introduced. The v1 descriptor field is optional and generated TS /
Swift models and the protocol surface snapshot are updated.

## Large-disc acceptance quota

The previous full-size Dolphin rerun remained blocked around 247 MiB in
Chromium's temporary context, even with ample filesystem free space. The same
1,459,978,240-byte original GameCube disc passed in **12.1 seconds** with a fresh
disk-backed persistent headless context. This test grants ordinary browser
storage permissions and removes its separate profile afterward. The production
disk staging, Web Locks, authenticated source download, WORKERFS, real JIT,
positive video output, screenshot and controller press/release path were used.

The large-disc test now uses this isolated persistent context. Smaller tests
keep the default context. Browser-storage errors suggest trying a regular
browser window as well as freeing space; freeing disk alone may not resolve a
temporary-context limit. Game audio is disabled before launch, Chromium is
headless and muted, and no user's native browser or profile is opened.

## Deployment and remaining scope

All four new profiles were installed through the local owner API. Atari800's
managed installation was upgraded after staging/validation, preserving support
files and the existing default/settings. The local service has 40 installed
profiles declaring 51 system IDs, including existing operator-local experimental
cores. This is an availability count, not 51 qualified commercial-game platforms.
All 807 saved metadata/artwork choice rows were preserved exactly, and health
passed with no active library jobs. Private backups and deployment receipts are in ignored
`dist-release/more-systems-20261031/`.

PokeMini, SameDuck and PC-FX still need content-level qualification; PC-FX needs
owner firmware. Synchronized saves remain disabled for all four new profiles.
N64 retains its documented coroutine/renderer blockers, and Dolphin Wii Remote,
encrypted Wii media and public corresponding-source reproduction remain deferred.
No firmware, commercial game, save or operator credential was added to Git.
