# Virtual Jaguar 3.10.0 compressed CHD acceptance

The installed BIOS-free `org.libretro.virtualjaguar` 1.1.0 player passed a real
Jaguar CD CHD browser boot on 2026-10-29. No core patch or rebuild was needed.
This extends the [CDI acceptance](jaguar-cd-hle-acceptance-2026-10-28.md).

The generated fixture contains two four-sector AUDIO tracks: silent session 1,
then session 2 holding the repository's original 68000 green-background/counter
program in Jaguar audio-sector byte order. The source CUE declares
`REM SESSION 01` and `REM SESSION 02`; no inter-session gap bytes or firmware are
copied. The upstream converter writes `CHSE SESSION:1`, track 1 `CHT2`,
`CHSE SESSION:2`, track 2 `CHT2` in that order.

Use the session-preserving converter in the official
[Virtual Jaguar v3.10.0 jagcd tools](https://github.com/libretro/virtualjaguar-libretro/releases/tag/v3.10.0),
which pins MAME `420968ca7a722418b27cbcaf5a332f83bde4a9be`.
The downloaded `jagcd-tools-macos.zip` matched upstream's SHA-256:
`a95be08d2f82f079296f3260c7eaefc91c665919d5a75135bdd61c7e2dadf882`.
The system's other `chdman 0.289` omitted sessions; the fixture generator rejects
that output with instructions to select the correct converter. A version number
alone does not establish that session metadata is supported. See
[MAME's session-metadata change](https://github.com/mamedev/mame/pull/15886)
and [upstream CHD operations](https://github.com/libretro/virtualjaguar-libretro/blob/ffea7893a59dd9b9e6f9b85c51627810338b0778/docs/jagcd-chd.md).

`generate-jaguar-chd-smoke.mjs` runs `createcd -c cdzl -hs 9792` outside the
repository and removes intermediate media. Four-frame hunks give this tiny image
two compressed hunks; the default single-hunk compressed conversion failed its
own `chdman info` check. The accepted CD Deflate CHDv5 image is 563 bytes,
SHA-256 `dd68786e0b897ebf3ce7c95fb093076cbfb91b3e86667c79de6615b80957c82d`.
The upstream `jagcd-chd-check` reported two sessions, two AUDIO tracks, CHSE
present, and no virtual pregaps.

```sh
ECS_ACCEPTANCE_CHDMAN=/absolute/jagcd-tools/chdman \
ECS_ACCEPTANCE_JAGUAR_PLUGIN=/absolute/installed-player \
ECS_ACCEPTANCE_HEADLESS=1 ECS_ACCEPTANCE_SOFTWARE_WEBGL=1 \
  pnpm --filter @ecs/web test:browser player-additional-cores.spec.ts \
  --grep 'Jaguar CD CHD'
```

The case passed in 27.7 seconds (41.5 seconds including runner startup), with
Chromium 145.0.7632.6 and ANGLE/SwiftShader. The opaque sandbox executed the
program, the guest counter advanced (115609 in the final snapshot), the canvas
compositor center pixel was `[0, 252, 0]`, and there were no page errors. The
unchanged player loader SHA-256 was
`18e98d8ad251363d509782023e34b2b7bffa3a4048856ebe922a2957c9c2531b`;
WASM SHA-256 was
`fff4746e146f15ea968edeb8ece6c1b8558ab5fe8819ec50814359ac52e7cc27`.

This verifies compressed CHD decoding, session-aware CD HLE boot, and original
CPU/video output. Commercial titles, audio, other CHD codecs, virtual pregaps,
real BIOS authentication, and synchronized saves remain outside this check.
