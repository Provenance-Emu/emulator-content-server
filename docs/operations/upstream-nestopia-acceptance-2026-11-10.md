# Pinned Nestopia playback, November 10, 2026

This check covers `org.libretro.nestopia` from the built-in ECS catalog.
The mutable upstream loader and WASM had both changed when checked. A fresh
ECS instance installed the catalog entry through its normal archive recovery
path using the [official October 31 archive](https://buildbot.libretro.com/nightly/emscripten/2026-10-31_RetroArch.7z).
The authenticated player resource endpoints returned the exact reviewed bytes.

| Resource | Size (bytes) | SHA-256 |
| --- | ---: | --- |
| Nestopia loader | 272,118 | `1256368b75e84c5c34ea741360fecc7d1709a2a3aba41ad1305ab040a4921627` |
| Nestopia WASM | 5,650,612 | `3ae618136aea28bd9a7b4abecfacda09ed9816766922d3444e4ac4d26b6c8a45` |
| Generated iNES program | 24,592 | `52c6dee458ca323ab4284495321f633ceb60d8a85eb311f6fa562a83543d2c6f` |

Chromium 145.0.7632.6 on arm64 macOS ran the original mapper 0
[acceptance program](../../examples/browser-playback/acceptance.s) in the
production opaque sandbox. Pressing A changed the palette. The canvas PNG
hash changed from
`f7e52f8e62fa2a923a4b8307b8a964e3e52dd8d9cb27a4efe4ebd612ae4cb197`
to `5e771aaf7f5673ec32a81fc777b02689ff4ad55b9cca1ff25b6a073552d1db5f`.
The Web Audio probe observed 101 buffers and a peak absolute sample of 0.223.
The test disconnected speaker output before starting the game and ran Chromium
headless with audio muted. Stopping playback removed the sandbox, and the test
closed the browser page and temporary server and removed their test data.

The profile declares `saveCompletion: none`. The player disclosed that
synchronized saves were unavailable and hid the battery and state save
controls. This check covers generated iNES playback, keyboard input, and
audio sample generation. UNIF, FDS, commercial titles, save persistence,
and other browsers remain outside this result. The
[reconstruction report](./upstream-reconstructions-2026-11-06.md) separately
records Nestopia's exact runtime reconstruction and the remaining provenance
questions.

## Reproduction

With Playwright Chromium, `ca65`, and `ld65` installed, run:

```sh
pnpm build && pnpm ui
ECS_ACCEPTANCE_UPSTREAM_NES=1 pnpm --filter @ecs/web test:browser player-upstream-nestopia.spec.ts
```

A cold archive recovery currently downloads about 775 MB. The test creates its
own server and data directory and writes `upstream-nestopia.json` to the
Playwright results directory. It builds all content from tracked source.
