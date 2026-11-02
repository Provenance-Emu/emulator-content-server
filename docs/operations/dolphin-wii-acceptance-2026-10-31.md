# Dolphin Wii execution and original large-disc fixtures

The pinned Dolphin browser core executes an original Wii homebrew DOL with HLE IOS58, Wii MEM2 and genuine VI/XFB video. Its existing GameCube-pad bridge works in Wii mode. Native Wii Remote buttons, pointing, motion and extensions still need a core input bridge; this result establishes a GameCube-controller fallback for compatible software, not general Wii title compatibility.

## Reproduce the silent headless proof

```sh
node scripts/browser-core/dolphin-browser-probe.mjs \
  /tmp/ecs-dolphin-wasm-20261030 NEW_EXTERNAL_OUTPUT --wii
node --test scripts/browser-core/dolphin-abi.test.mjs \
  scripts/browser-core/dolphin-gc-iso-smoke.test.mjs
```

The browser probe always launches headless Chromium with `--mute-audio`. It creates two temporary loopback origins: a COOP/COEP parent and a different-origin isolated companion. The companion serves only fixed bootstrap HTML. Verified loader, WASM, host adapter and original program bytes travel through one private MessagePort. Runtime CSP permits blob module/worker resources; no credentials, content API or filesystem server is exposed by the companion.

The unchanged WASM is 15,175,335 bytes, SHA256 `d7395b3a94080f5b7d08a0522f59096007419d117b7b0eb868246429adee6f5c`. The existing bounded pthread-pool loader is 266,969 bytes, SHA256 `0bfc73fbbf370d831fbce04239f062a93f885c053a86866ce5dca3a879be331f`. No new core bytes or pins are needed for this Wii boot path. Source is [wasm-dolphin commit 7e38409](https://github.com/dougchansan/wasm-dolphin/tree/7e38409ace3dda709c178312ff63fd92a3653cc7), based on Dolphin `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1`.

Receipt outside the repository: `/tmp/ecs-dolphin-wii-browser-20261031-final/dolphin-browser-result.json`; actual canvas capture: sibling `dolphin-browser.png`. Chromium `145.0.7632.6` reported:

| Evidence | Observed result |
| --- | --- |
| Wii DOL hash | `72e5ef2aa872bfed5e937ffed6e60ef0bdd62dca3733aa3e3037694462e010c6` |
| Core state / clock | Running / 729,000,000 ticks per second |
| HLE IOS version read by guest | `0x003a1820` (IOS58) |
| Guest Wii MEM2 read/write witness | `0x57494931` copied from `0x90001000` into MEM1 |
| Original guest counter | Advanced to 21,264,623 |
| PPC-to-WASM execution | Five compiled blocks, 21,295,355 block dispatches |
| Genuine VI sequence | Three observed distinct positive XFB frames; final sequence 6 |
| Display | 320×240 guest XFB, 160×120 presentation; green `[0,255,1,255]` / blue `[0,0,255,255]` |
| Core GameCube-pad poll | A pressed: input mask `1`, generation `123`, native button mask `0x100`; released: mask `0`, generation `124` |
| Browser errors / companion requests | Zero / one fixed bootstrap GET |

The acceptance rejects metadata placeholders and `xfb:0`. It requires advancing guest counter/JIT dispatches, Wii clock/IOS/MEM2 witnesses, actual core pad poll observations and distinct VI sequences. The program exercises XFB scanout directly; it does not establish GX rendering, commercial-disc compatibility, audio quality, encrypted Wii partitions, WAD installation or NAND-dependent applications. The guest does not itself consume controller responses; the evidence reaches the core's `Pad::GetStatus` bridge, not a guest input-driven gameplay response.

## Wii executable boot and host requirements

`dolphinVideoSmokeDol({ wii: true })` emits entirely original PowerPC instructions. Dolphin's [DOL reader](https://github.com/dolphin-emu/dolphin/blob/e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1/Source/Core/Core/Boot/DolReader.cpp) detects Wii executables by a HID4 write instruction in text. The generated program first reads HID4, then writes the preserved value back. Writing zero would disable the SBE/BAT mapping established for Wii and invalidate MEM2 access. Wii text starts at `0x80008000`; witnesses at `0x8000f800` avoid the Wii low-memory boot fields around `0x80003100`.

[Executable boot](https://github.com/dolphin-emu/dolphin/blob/e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1/Source/Core/Core/Boot/Boot.cpp) uses the detected Wii mode to configure registers/BATs, prepare Wii memory and boot HLE IOS58 before loading the DOL. [Boot memory setup](https://github.com/dolphin-emu/dolphin/blob/e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1/Source/Core/Core/Boot/Boot_BS2Emu.cpp) creates the generated Wii settings. This proof supplies no Nintendo NAND, BIOS, keys, disc bytes or firmware files.

The host uses the same configuration as the GameCube proof: `SetVideoBackend("Software Renderer")`, `SetCpuCore("cached")`, `SetCpuThread(0)`, `SetPpcWasmJitEnabled(1)`, `CoreInit()`, then `BootDisc(pathToDol)`. No separate exported Wii-mode setter exists or is needed. Poll `PumpHostJobs`, `GetCoreStateName`, `GetCoreTicksPerSecond`, JIT counters and positive `GetVideoStats` XFB sequence; obtain pixels through `FrameWidth`, `FrameHeight`, `FrameBuffer`. Input is `SetInputState`. The main core must run in a worker with shared memory and cross-origin isolation; the pinned module reserves 1.5 GiB. Retain the existing verified blob loader options `mainScriptUrlOrBlob` and `locateFile` mapping for `dolphin-core-upstream.wasm`.

The current [browser pad implementation](https://github.com/dougchansan/wasm-dolphin/blob/7e38409ace3dda709c178312ff63fd92a3653cc7/core/upstream/dolphin_web_discio.cpp) and [GCPad patch](https://github.com/dougchansan/wasm-dolphin/blob/7e38409ace3dda709c178312ff63fd92a3653cc7/patches/dolphin-wasm/0001-browser-platform-build-gates.patch) feed GameCube port zero. No Wii Remote state export connects browser buttons, IR, accelerometer or Nunchuk state to WiimoteEmu/Bluetooth reports. A future implementation needs a thread-safe Wii Remote state setter, configured connected emulated device, report-generation bridge and an original Wii program that reads those reports. Configuration or catalog changes alone cannot provide those controls.

No new source build was attempted: the fork's checked [toolchain lock](https://github.com/dougchansan/wasm-dolphin/blob/7e38409ace3dda709c178312ff63fd92a3653cc7/provenance/wasm-toolchain.lock.json) specifies Windows x64, Emscripten 5.0.7 and Windows Rust/Naga tooling; the local cached SDK is 3.1.46 and this checkout lacks the upstream vendor tree. Port that toolchain/build path before attempting a reproducible Wii Remote core change. Existing pinned execution already proves Wii mode without that rebuild.

## Original sparse GameCube ISO for large-file acceptance

```sh
node scripts/browser-core/dolphin-gc-iso-smoke.mjs NEW_EXTERNAL_ISO
```

The generator returns segments plus logical size and writes them sparsely outside the repository. It opens with exclusive creation, preserves existing operator files and keeps resident generated content below 4 KiB. The default logical size is 1,459,978,240 bytes; this is an actual GameCube header, original PPC apploader, original video DOL and root-only FST. The apploader requests only the 196-byte text section from the 452-byte DOL. The remaining image is holes, so no enormous padded DOL allocation is necessary. No source, loader, ROM or BIOS bytes are copied from a console or game.

External fixture: `/tmp/ecs-original-gamecube-sparse-20261031.iso`; segment receipt: `/tmp/ecs-original-gamecube-sparse-20261031.json`. APFS reported 144 KiB physically allocated. The default original DOL remains SHA256 `7d6123b0dad9d74883586dd366b10774a7b411ff5d177d3464ea7bdac6084ce7`.

A bounded-read NODEFS boot against the same pinned core (`/tmp/ecs-dolphin-iso-node-v4.mjs`, receipt `/tmp/ecs-dolphin-iso-node-v4.log`) returned `MountDisc=1`, platform GameCube, `BootDisc=1`, Running, 9,829,543 real JIT dispatches and XFB sequence 8 with the same two real colour bands. It mounted an external file rather than copying 1.46 GB into MEMFS. This establishes fixture validity; the production OPFS/File/WORKERFS browser loading acceptance is a separate test owned by the production host workstream.

Focused checks cover the preserved GC DOL hash, Wii HID4 mapping regression, Wii reserved-safe layout, bounded non-overlapping disc segments, coherent DOL/FST pointers, sparse output, zero-filled holes, refusal to write into the repository and preservation of an occupied output path.
