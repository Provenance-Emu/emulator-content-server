# Pinned browser core build

See [browser playback operations](../../docs/operations/browser-playback.md) for the exact base/core/SDK and operator trust requirements. `build.mjs` accepts external frontend and core checkouts plus a new/empty operator directory. It checks source identity and the exact patch before cloning committed sources into fresh temporary build directories and invoking the upstream build with two workers. Build checkouts force canonical LF independently of user Git settings; permitted working patches are compared by canonical Git blob content. Ignored/untracked objects and config files from operator checkouts never enter the build; original checkouts are not cleaned or modified. No emulator binaries or media belong in this directory.

`retroarch-save-files.patch` modifies RetroArch's GPL-3.0-or-later `save.c`, copyright Daniel De Matteis and Brad Parker. Its context remains under the upstream license; see the [pinned source and license](https://github.com/libretro/RetroArch/blob/4d4bfc0fbaacca30d433e5c11b0b2b5242141b66/COPYING). The patch prevents absent RTC memory from falsely failing a completed SRAM save and does not suppress real write errors or make a core without any save memory report success.

Run `node --test scripts/browser-core.test.mjs` for the compiled dispatch regression and build-directory guards. The C probe runs when `cc` (or `$CC`) is available and otherwise reports an explicit skip; real browser/native-core acceptance remains separate.

## Install the build through the plugin registry

After `pnpm build`, convert the verified output into a new external plugin directory:

```sh
mkdir -p "$HOME/Library/Application Support/Emulation Server/players"
node scripts/browser-core/install-plugin.mjs /absolute/new-operator-core \
  "$HOME/Library/Application Support/Emulation Server/players/fceumm"
```

The installer validates the pinned profile and hashes before writing anything, copies
independent loader/WASM bytes, and refuses to replace an existing installation.
Start the server with `--player-plugins` pointing at the **players** parent directory.
It uses the new `org.libretro.fceumm` profile; `--player-dir` is not required.
No binary is added to this repository or the desktop installer.

Run the real-core acceptance after building the server/UI:

```sh
ECS_ACCEPTANCE_CORE=/absolute/new-operator-core \
  pnpm --filter @ecs/web test:browser player-real-core.spec.ts
```

This opt-in test compiles the original assembly program with ca65/ld65, runs an
isolated temporary server with only the plugin registry, and checks real rendering,
keyboard input, nonzero WebAudio samples, SRAM/state round trips and shutdown.
It uses a headed browser with working WebGL and requires the external build and cc65; normal browser runs explicitly skip it. See the [2026-10-28 acceptance record](../../docs/operations/browser-playback-plugin-acceptance.md).
No operator catalog, real game or save is used.

## Virtual Jaguar 3.10.0 cartridge and CD HLE

`build-virtualjaguar.mjs` builds RetroArch `4d4bfc0f` with Virtual Jaguar
`ffea7893` (core version `3.10.0`) using the same SDK `3.1.46`. Both input
checkouts and the new output directory must be outside this repository. The
helper reads committed build inputs and replaces all four embedded boot-ROM
arrays with zero initializers before compiling or archiving sources. It disables
external firmware staging, forces the original upstream CD HLE strategy for both
initial loading and disc insertion, and refuses no-content BIOS boot, audio-only
CDs, and cartridges which require real boot firmware.

```sh
node scripts/browser-core/build-virtualjaguar.mjs \
  /absolute/pinned-retroarch /absolute/pinned-virtualjaguar \
  /absolute/new-virtualjaguar-plugin
node --test scripts/browser-core/jaguar-hle.test.mjs
ECS_ACCEPTANCE_JAGUAR_PLUGIN=/absolute/new-virtualjaguar-plugin \
  ECS_ACCEPTANCE_CHDMAN=/absolute/jagcd-tools/chdman \
  ECS_ACCEPTANCE_HEADLESS=1 ECS_ACCEPTANCE_SOFTWARE_WEBGL=1 \
  pnpm --filter @ecs/web test:browser \
  player-additional-cores.spec.ts --grep 'BIOS-free Jaguar'
```

The generated profile (1.2.0) supports Atari Jaguar and Jaguar CD with CDI/CHD
files and CUE/BIN groups, capped at 512 MiB total by the browser profile contract. Jaguar
CHDs require the session metadata accepted by the upstream core; see
[upstream CHD operations](https://github.com/libretro/virtualjaguar-libretro/blob/master/docs/jagcd-chd.md).
The browser preserves CUE session/index directives and stages authorized BINARY
tracks under controlled flat names. Both scanned groups and uploaded item assets
are supported, with at most 128 staged files and a 64 KiB CUE descriptor. Use the
session-preserving converter from Virtual Jaguar's jagcd-tools release for CHD
fixtures; the generator rejects converters that discard CHSE metadata.
Synchronized saves remain unavailable. The opt-in CD cases generate two-session
CDI, compressed CHD and CUE/BIN programs and check
actual emulated 68000 progress and a rendered green frame; it makes no claim
about commercial game compatibility.

The software-WebGL switch affects only this opt-in browser test. On the acceptance
Mac, default headless Chromium failed before core initialization for both the old
published profile and the new build. Explicit ANGLE/SwiftShader provided a working
WebGL context for the recorded three-case acceptance; the production sandbox and
runtime options were unchanged. `ECS_ACCEPTANCE_RUNTIME_DIAGNOSTICS=1` adds a
test-only exception logger to the isolated sandbox response when diagnosing a
startup failure.

The earlier ECS cartridge-only package used the same `3.10.0` source family but
its distribution wrapper explicitly rejected `is_cd_content` and removed the CD
extensions. That limitation was in our wrapper, not an absence of upstream CD
emulation. Upstream's ordinary builds contain console and CD boot-ROM arrays;
their availability does not mean those firmware bytes are needed by CD HLE or
included in this profile. The official
[v3.10.0 release](https://github.com/libretro/virtualjaguar-libretro/releases/tag/v3.10.0)
also supplies an Emscripten bitcode core; this recipe builds sanitized source
instead of redistributing its embedded firmware.
