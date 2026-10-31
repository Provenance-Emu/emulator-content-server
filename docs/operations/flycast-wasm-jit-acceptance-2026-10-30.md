# Flycast WASM JIT acceptance — 2026-10-30

The operator-local `org.flycast.wasm-jit` profile runs the real SH4-to-WebAssembly
recompiler through ECS's existing plugin, authenticated content and opaque iframe
paths. The original Dreamcast program advances guest RAM and renders a green
frame in Chromium and Playwright WebKit. Native Safari Flycast acceptance remains
unverified because the computer-use guard stopped the browser session after the
active user page changed to a restricted URL. No interaction with that page or
Safari security-setting change was attempted.

## Exact inputs and scope

| Input | Pin |
| --- | --- |
| Flycast | `2c48c0188a2afc158b02b6d1865d898756a03071` |
| SH4/WASM port | `nasomers/flycast-wasm` at `16e9c7b4b7065a4bd42e7490e8aab3e9283d5415` |
| RetroArch | `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66` |
| Emscripten | 3.1.46 |
| Loader | 301,391 bytes; SHA-256 `48545bfba050fc0adccebaeb9532cc60326196780532060997969138e528275c` |
| WASM | 8,632,199 bytes; SHA-256 `252d612e8eac2a3c1ccd95a50a612e5449e78fe3678afde4770708fe1a480221` |

The profile advertises Dreamcast, WebGL2, a single-threaded MEMFS runtime, up to
512 MiB of content, and no synchronized saves. Naomi, Naomi 2 and Atomiswave are
not advertised by this profile until their firmware staging and boot acceptance
are implemented. Existing paraLLEl DC operator profiles remain separate.
Commercial games, disc/audio compatibility, physical-controller behavior and
long-session stability have not been established by this original-program test.

The emitter dynamically compiles WASM and installs functions into the growing
WASM table. `DYNAMIC_EXECUTION=0` prevents general JavaScript code generation.
The measured native dispatch count increments only after a call into an actual
runtime-compiled block returns; mode 6 alone is not treated as proof of JIT work.
No emulator bytes, firmware, saves or game fixtures are committed.

## Integration fixes

- Link the real emitter/core against the selected ESM frontend, with exported
  memory/import helpers, WebGL2 and a growing function table. Small source
  compatibility aliases replace unavailable legacy pathname symbols. An absent
  WebGL extension retains a null optional function pointer; capabilities and
  GL version strings are not spoofed, and undefined symbols are not suppressed.
- Replace the port's invalid opcode-zero import warmup with SH4 NOP `$0009`.
  Keep the HLE/framebuffer defaults enabled and threaded rendering disabled in
  the WASM build. The port-specific AudioWorklet is compiled out; normal libretro
  audio callbacks use the existing frontend driver. Audio output is unverified.
- Give the real sandbox canvas its standard `canvas` ID for Emscripten's hardware
  context selector. Disable unsupported guest wake-lock requests in the opaque
  frame instead of granting another browser capability.
- Make the original generated ELF's section table acceptable to Flycast's
  libelf, unblank video output, and explicitly configure the 480-line pixel
  clock. These are original guest-program corrections, not a host-generated
  replacement frame. Generated-code regressions preserve segment ranges and
  simulate the program's framebuffer register writes.

CSP, `sandbox="allow-scripts"`, owner-only content access, byte/hash verification,
private message-port handshake, worker prohibition and credential isolation are
unchanged. The player is loaded from a verified local package through the normal
management API; no download allowlist exception is needed.

## Browser evidence

The [machine-readable receipt](flycast-wasm-jit-acceptance-2026-10-30.json) separates
these environments:

- **Chromium 145, full ECS page:** authenticated original ELF upload, selected
  plugin, normal startup, real emulated RAM changes, a green compositor pixel
  `[0,252,0]`, no page errors, and the unchanged opaque sandbox. The focused case
  passed again in 24.1 seconds after merging the latest controller/input UI. Headless Chromium explicitly enables its software WebGL
  renderer; this does not establish hardware GPU or game performance.
- **Playwright WebKit 26.0, opaque runtime harness:** mode 6, successful JIT
  dispatches `4,281,071 → 5,959,895`, guest counter `4,129,486 → 5,808,310`, and
  green pixel `[0,252,0,255]`. The frame is opaque and not cross-origin isolated;
  no shared memory or special browser permission is required. This is WebKit
  acceptance, not native Safari acceptance.
- **Native Safari 26.6.2 baseline:** the existing ProSystem profile rendered its
  original program with the same sandbox/CSP, opaque origin and no isolation.
  Flycast's native Safari run was subsequently blocked by the computer-use guard;
  the baseline must not be reported as a native Safari Flycast pass.

The opt-in `safari-jit-acceptance.mjs` serves only an explicitly selected,
hash-checked profile and generated original program on a random loopback path.
Its test-only diagnostics expose aggregate JIT counters and the original
program's fixed RAM location, not a production arbitrary-memory API. It preserves
the production sandbox/CSP and requires an advancing JIT counter, changing guest
RAM and a real green screenshot to pass. Its local receipt is not an attestation
from an untrusted remote browser.

## Local installation

The verified package is installed and enabled through the owner-only management
API on the running local server. Reload the UI and select **Flycast (experimental
WASM JIT)** for Dreamcast. Both installed assets were fetched through authenticated
HTTP and checked against the accepted hashes. The existing default emulator and
all 807 saved metadata/artwork choices are unchanged; no matching or scanning job
was started. The private package and detailed local receipts remain in the ignored
`dist-release/flycast-jit-20261030` directory.

## Build, validation and distribution

Use the [source recipe](../../scripts/browser-core/FLYCAST-WASM.md). Builds happen
in new committed snapshots, including exact recursive dependency gitlinks;
caller working files and ignored build output are preserved. Materialized
submodule HEADs and tracked changes are verified before/after compilation. The
pinned zlib configure-time header rename is restored only from an exact committed
copy. Patch digests, dependency pins and computed output hashes enter the receipt.
The final source snapshot was independently compared with the source used for
the accepted artifact; wrapper-safety changes did not change emulator code.

Focused Git-snapshot/dependency-preservation tests, generated SH4 regressions,
Dolphin ABI guards, player-catalog checks, TypeScript and changed-file checks pass.
The full emulator/OS matrix was not run.

The combined binary is **operator-local only**. The port's upgrade grant for
combination with the GPLv3 frontend remains unresolved; no public binary release
or download URL is provided. This is distinct from runtime compatibility, which
is now demonstrated. Fonts retain the upstream free-font notices. Upstream
arcade flash/NVMEM presets and a game-specific print template are excluded.

Dolphin's separate [prototype](dolphin-wasm-prototype-2026-10-30.md) executes an
original PPC DOL through its real WASM JIT. Its current 1.5 GiB shared-memory,
pthread build cannot run in the opaque player. Its ABI adapter and bounded probe
are committed, while a cooperative non-threaded port or separately reviewed
isolated-origin runtime remains required. No dummy frames or stub save APIs are
reported as working Dolphin emulation.
