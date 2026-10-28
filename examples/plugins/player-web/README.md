Copy this directory into your operator-owned player registry, for example
`/opt/ecs-players/example/`. Add your generated Emscripten ES module as
`loader.js`, your WebAssembly binary as `core.wasm`, and replace both zero
SHA-256 placeholders with hashes of those exact bytes. Set the supported systems,
content extensions, build version and content size limit to match your build.

Start with `ecs serve --data ./content-data --player-plugins /opt/ecs-players`.
`ECS_PLAYER_PLUGINS` selects the same absolute registry path. The flag is also
persisted by `ecs service install`. Each immediate registry subdirectory contains
one `plugin.json`; server startup validates all profiles together and fails on an
invalid profile. Restart the server after replacing installed builds.

This is an installation template, not a bundled emulator. No JavaScript or WASM
runs in the server. Only declared, hash-verified startup snapshots are exposed at
protected routes. The browser runs the selected profile inside its isolated
player frame.

For `emscripten-esm-v1`, the loader exports a default async Emscripten module
factory with MEMFS, `callMain`, and `canvas` support. WASM is supplied as
`wasmBinary`; declared assets are available through `locateFile` / `getPreloadedPackage` and are staged as `/ecs/system/<name>` in MEMFS before content is launched.
Choose `retroarch-emscripten-esm` only for compatible RetroArch builds. Use
`command-reply-v1` only if your build implements the matching save completion
protocol; `none` disables save export controls.

Optional `web.assets` entries contain `name`, `file` and `sha256`. Filenames and
browser names are flat portable names. At most 16 assets totaling 32 MiB, an
8 MiB loader, a 64 MiB WASM binary, and 64 MiB content are supported. The registry
supports at most 16 profiles and 256 MiB of snapshots. Threads and persistent
filesystems are unsupported. The legacy pinned `--player-dir` remains supported
and becomes the default profile when both options are configured.
