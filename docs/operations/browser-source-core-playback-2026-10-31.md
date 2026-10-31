# Source-core playback qualification, 2026-10-31

PokeMini, SameDuck and Beetle PC-FX now run content through the authenticated
application player, including native controller input. The operator-local
Mupen64Plus-Next port also executes an original cartridge and responds to input.
The four final headless checks passed together in 24 seconds. Source/compiler
pins, content hashes, captured-pixel statistics and before/pressed/after frame
hashes are in the [receipt](browser-source-core-playback-2026-10-31.json).

| System | Evidence | Remaining limits |
| --- | --- | --- |
| Pokémon Mini | Original Minx code polls the actual keypad and toggles the LCD on A press/release; separately, an owner-supplied Pokémon Party Mini boots with FreeBIOS | Peripherals and synchronized saves unverified |
| Mega Duck | Original SM83 cartridge polls JOYP and switches the rendered background shade on A press and release | Commercial titles and synchronized saves unverified |
| PC-FX | Owner BIOS boots a complete CHD of MIT-licensed Simple Battle FX; Start moves its title screen into the Duel/Survival menu | Commercial discs and synchronized saves unverified; owner `pcfx.rom` required |
| Nintendo 64 | Original MIPS code renders green/blue gradients through VI and reads SI/PIF input; guest A turns the display blue and release restores green | CPU interpreter; original VI test does not establish RSP/RDP commercial-game coverage; local package only |

The existing controller bridge was limited to previously qualified exact binary
pairs. These four pinned pairs now enable it too. Changing either loader or WASM
hash disables the bridge until that build is qualified. No player sandbox or
loader capability restrictions were relaxed.

## N64 source port

The source recipe uses real Emscripten fibers with full Asyncify. Its lifecycle
regression compiles and executes the actual C backend as WASM, checking nested
suspended stack state, active context identity, return to the caller, and repeated
create/delete heap recovery. The core's coroutine entry now has the correct
function signature. Vendored graphics/audio symbols have their own namespace,
GLES3 is selected for WebGL2, and native renderer threads are disabled at compile
time. Missing imports are not fabricated.

The final Binaryen optimization pass is O0 after its optimized Asyncify pass
stalled; LLVM objects retain their normal optimization. Explicit release
assertions and the pinned SDK's AST whitespace printer produce an ESM loader
that passes the existing capability scan. A rebuild of the external source stage
produced byte-identical loader, WASM and manifest. The N64 package stays local
while the GLideN64 redistribution permission question is unresolved; the UI
explains that limitation. Build and qualification commands are in the
[source notes](../../scripts/browser-core/n64-source-notes.md).

With the default N64 core mapping, keyboard **Z** (Libretro B) is N64 A. The
original test program reads both controller-response bytes. Standalone Libretro A
is not mapped by upstream's default `alt-map=False` layout; a C-button mode or
alternate map changes its meaning. The standard configurable controller editor
remains available.

## Repeating acceptance

`apps/web/test/browser/player-source-cores.spec.ts` installs each external package
through the owner API into an isolated server, uploads its content and optional
firmware through the client, then uses the real `/play` flow. Supply an external
JSON array via `ECS_ACCEPTANCE_SOURCE_CORES_JSON`; each entry has `id`, `system`,
`package`, `content`, `extension`, `kind` and optional `firmware` filename-to-path
map. Kinds are `pokemini-original`, `pokemini-owned`, `megaduck-original`,
`pcfx-homebrew` and `n64-original`. Missing cases skip explicitly.

The original cartridge generators are source-only:
`generate-pokemini-smoke.mjs`, `generate-megaduck-smoke.mjs`, and
`n64-source-original-program.mjs` under `scripts/browser-core`. Generate binaries
outside the repository. PC-FX acceptance uses the author's MIT release from
[Simple Battle FX](https://github.com/gameblabla/simplebattlefx-pcfx/tree/50a1329a9fb45f41d6540db219cfe7fad9adeb68),
converted to CHD with `chdman createcd`; its BIOS is owner-supplied.

The test disables emulator audio before `main`, launches muted headless Chromium
with its software WebGL renderer, and retains external receipts/captures. It
waits beyond PC-FX's BIOS animation and compares the title region outside its
blinking prompt. N64 and the original handheld programs must react in both
press and release directions. Pages and isolated servers close in `finally`.
No user's native browser, profile or ROM library is driven. No binary content,
BIOS, captures, saves or credentials are tracked.

## Local deployment

The running local service now serves the updated player UI. N64 was installed
through the owner package API, and PC-FX received the owner's existing BIOS
through the support-file API. It has 41 profiles declaring 52 system IDs; that
count includes experimental profiles and does not imply commercial-game
qualification for every system. All 807 saved metadata/artwork selection rows
were compared exactly against the consistent pre-deployment SQLite backup.
Existing player settings and the default core are unchanged. Health passed,
with no active library jobs. Private backups and receipts remain in ignored
`dist-release/source-core-playback-20261031/`.
