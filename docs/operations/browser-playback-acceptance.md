# Browser playback acceptance, 2026-10-20

The tested operator pair uses RetroArch upstream base `4d4bfc0fbaacca30d433e5c11b0b2b5242141b66`, FCEUmm `ac0d00a7fc01166f84c7bac01d1084ebfd2b865e`, Emscripten SDK `3.1.46` (`19607820c447a13fd8d0b7680c56148427d6e1b8`), and the [bundled SRAM dispatch patch](../../scripts/browser-core/retroarch-save-files.patch), SHA-256 `ffc78048f23214a2aaccd84e7c8e443edfce06a194aa501818dcb11923738f21`. This is a patched upstream base, not an unmodified frontend acceptance claim. Build it with the [operator recipe](browser-playback.md).

| Artifact | Actual SHA-256 |
| --- | --- |
| `fceumm_libretro.js` | `4198e886f14d2c82a41c6405523f6dc748177bf1a4cadb97e93ce49a77cfcef8` |
| `fceumm_libretro.wasm` | `68961e7837621bd195bd17380a7e437ad90b699ae220019d3bebf1587060542b` |

The final isolated recipe at source commit `761ac6b7fb86a123d14d9dc79293013ea4fbe422` completed with exit 0. An earlier patched build had WASM SHA-256 `39d1241e73960d34af4922c1bb5a4d77ace104e7e86a2405ea6a0360e7e3482b`. The fresh shallow clone embeds Git version `4d4bfc0` instead of `4d4bfc0fba`, shortening the binary by three bytes and relocating addresses. This explains these two builds; universal bit-for-bit reproducibility is not claimed. The final pair repeated rendering, input, WebAudio, SRAM persistence, state restoration, proxy authentication, stale conflicts, retry and read-only export. The three failure/recovery rows below were established on the earlier patched pair; their final-pair repetition is tracked in the acceptance run report.

Native builds and browser execution ran on macOS with the in-app Chrome `155.0.0.0` / WebGL browser, against a temporary server with `localTrust: false` and a separate loopback HTTP reverse proxy. Public TLS deployment was outside this local acceptance scope. No system trust settings were changed. Only generated device credentials and temporary data were used.

The original [assembly program](../../examples/browser-playback/acceptance.s) has an 8 KiB battery counter, changes its backdrop on NES A (`x`), and produces pulse audio. Generate it outside the repository with cc65 tools:

```sh
ca65 examples/browser-playback/acceptance.s -o /tmp/ecs-acceptance.o
ld65 -C examples/browser-playback/nes.cfg /tmp/ecs-acceptance.o -o /tmp/ecs-acceptance.nes
```

No generated ROM, core, BIOS or save binaries are tracked.

| Check | Result |
| --- | --- |
| Exact SDK/core/base plus patch build, ES-module factory, MEMFS, direct command ABI | PASS |
| Shipped player renders and responds to held keyboard input | PASS |
| Real WebAudio buffers, running context and nonzero signal | PASS; peak `0.10589169710874557`, 889 queued buffers in a final-pair sample |
| Physical speaker listening | UNTESTED; no audibility claim |
| Completed SRAM capture/upload and fresh-document SRAM restoration | PASS; counter 1 → input 2 → save → reload selected SRAM → 2 |
| Completed slot-0 state capture/upload/reload/load | PASS; final pair saved counter 2, input changed it to 3, selected state restored 2 |
| Bearer-only reverse-proxy loading and unauthorized core access | PASS; token mode even for loopback, unauthenticated descriptor/loader return 401 |
| Phone/browser stale SRAM saves remain separate | PASS; phone counter 9 and browser counter 3 retained as separate 8192-byte assets |
| Failed upload and retry retain captured bytes | PASS; injected proxy 503 retained counter 3 at base revision 4; gameplay advanced to 4 before Retry uploaded the original counter-3 bytes |
| Read-only completed SRAM capture and export | PASS; actual upload 403, manifest revision 7 unchanged, exported 8192 bytes with SHA-256 `134c8cb6944ec5737c2f577563cf3769170a1678ed9efca51b6000aef6fbceda` |
| Actual SRAM filesystem write error | PASS; replacing the save directory with a regular MEMFS file caused native write failure, error reply, no pending upload, then quarantine |
| Command timeout and recovery | PASS with injected dropped replies; native state task completed, reply was deliberately withheld, 30-second timeout quarantined the channel; fresh document saved successfully |
| Failed startup and recovery | PASS with injected invalid WASM section; WebAssembly rejected it before commands; a fresh document with intact assets started and saved successfully |

The first real run exposed two failures: the web loader check mistook `importScripts` feature detection for an import statement; and unmodified upstream `SAVE_FILES` falsely failed after saving SRAM because FCEUmm has no RTC region. The web regression retains rejection of actual imports/workers/worklets. The patch regression compiles the actual patch function with controlled memory/write boundaries and checks absent RTC, all regions absent, SRAM/RTC write errors, both regions present, disabled SRAM and missing save list.

These results apply to this single-file NES/MEMFS profile and exact artifacts. They do not establish arbitrary save interoperability, other systems, nightly pairs, threaded builds or broader emulator support. Operator builds still require local validation with known-compatible saves.
