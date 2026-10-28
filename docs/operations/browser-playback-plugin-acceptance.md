# Real FCEUmm plugin acceptance — 2026-10-28

The new player registry and opaque-origin launcher passed a real NES core acceptance run on macOS Apple Silicon, headed Chromium 145.0.7632.6, Node 22.22.2. The server was temporary, token-only (`localTrust: false`), and configured **only** with `playerPluginsDir`. The legacy player endpoint returned 404; unauthenticated plugin loader access returned 401. No operator catalog or commercial content was used.

The exact upstream pins were RetroArch `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66`, FCEUmm `ac0d00a7fc01166f84c7bac01d1084ebfd2b865e`, and Emscripten 3.1.46 (`19607820c447a13fd8d0b7680c56148427d6e1b8`). The existing two-worker [build helper](../../scripts/browser-core/build.mjs) applied the SRAM correction with SHA-256 `ffc78048f23214a2aaccd84e7c8e443edfce06a194aa501818dcb11923738f21`; it completed with exit 0 from fresh external source/SDK checkouts. No existing user checkout/toolchain was modified.

| Actual artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Loader | 270617 | `4198e886f14d2c82a41c6405523f6dc748177bf1a4cadb97e93ce49a77cfcef8` |
| WASM | 4209159 | `c54d033d3f7856074e48bf824bc92b9b2e6f9cf3d529d4d646685ed626d62205` |

This fresh WASM differs from the earlier acceptance build, so these measured hashes identify the tested bytes. No universal reproducibility claim is made. The [installer](../../scripts/browser-core/install-plugin.mjs) validated the pinned descriptor/digests and copied independent bytes into a new `org.libretro.fceumm` plugin installation. It refuses to overwrite existing installs or write binaries inside this repository.

The [opt-in browser test](../../apps/web/test/browser/player-real-core.spec.ts) compiled the original [assembly program](../../examples/browser-playback/acceptance.s) with ca65/ld65. It loaded the production player and **unmodified** first-party sandbox bootstrap. Only the test's AudioBufferSourceNode observer measured audio while calling through to the original implementation. No loader/WASM modification, privileged runtime hook, fake core or credential bridge was used in the final passing run.

| Check | Result |
| --- | --- |
| Plugin catalog selection and authenticated byte fetching | PASS; `org.libretro.fceumm`, no legacy adapter |
| WASM/MEMFS/main startup in `sandbox="allow-scripts"` | PASS; WebGL display created |
| Real rendering and keyboard A input | PASS; backdrop screenshot changes and NES battery counter 1 → 2 |
| Audio generation | PASS; 225 queued buffers, peak absolute sample 0.1982250213623047 |
| Battery capture/upload | PASS; 8192 bytes, counter/magic bytes `[1, 0xa7]` then `[2, 0xa7]` |
| Fresh-document battery restoration | PASS; counter 2 restored, keyboard input advances it to 3 |
| Completed slot-0 state capture/upload/restoration | PASS; state saved at 2, later battery 3, fresh start with both restores counter 2 |
| Stop/navigation disposes the frame | PASS; returned to library with no emulator frame |
| Unhandled runtime errors | None in the passing run |

The real state file is compressed and may be smaller than SRAM; successful byte restoration, not an arbitrary minimum size, establishes this check. The test's observed battery sequence is `[1, 2, 2, 3, 2]`. Its final clean run passed in 20.5 seconds including browser startup.

## Reproduce

Build the pinned pair externally using the [recipe](browser-playback.md), run `pnpm build && pnpm ui`, then:

```sh
ECS_ACCEPTANCE_CORE=/absolute/operator-core \
  pnpm --filter @ecs/web test:browser player-real-core.spec.ts
```

This opt-in test uses a headed browser by default and requires a usable WebGL driver/display plus ca65/ld65. Normal browser runs explicitly skip it without an external core. Set `ECS_ACCEPTANCE_HEADLESS=1` only in an environment with working headless WebGL; this Mac's default headless Chromium failed graphics-context creation. No sandbox/origin restriction was relaxed to make the headed run work. Keyboard activation is used for battery/Stop controls to avoid headed macOS pointer-focus instability.

The test writes its generated screenshot and JSON measurements to Playwright's output directory. Core binaries, generated program/save/state files and temporary catalog stay outside the repository; the temporary server and catalog are removed after the run. The validated core is separately installed in the local operator registry, and the live server's loader/WASM hashes were checked over its actual API without creating a game or save in the operator catalog.

This acceptance does not establish physical speaker audibility, gamepad mappings, real Safari/Firefox behavior, public TLS/proxy deployment, new save-conflict scenarios, arbitrary NES save compatibility or other systems. Existing generated tests cover isolation, cancellation, conflict/retry and access boundaries. The [earlier acceptance](browser-playback-acceptance.md) remains separate historical evidence for its exact artifacts and broader failure scenarios.
