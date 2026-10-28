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
