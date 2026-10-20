# Web playback

The content server provides an isolated first-party `/play/` document alongside `/ui/`, using the same API, account and library. The implemented initial profile is one explicitly configured trusted single-thread RetroArch/FCEUmm ES-module loader/WASM pair for single-file NES content. Configuration is optional: `--player-dir` points at a dedicated browser-static directory, separate from data and plugin directories. No nightly/buildbot fallback or plugin-directory mounting is supported.

See [Browser playback operations](../operations/browser-playback.md) for exact frontend/core/SDK pins, the proposed unverified build recipe, operator-computed artifact hashes, source target selection, save compatibility limits and manual acceptance. [ADR 0008](../architecture/decisions/0008-browser-static-player.md) records this narrow static distribution exception to ADR 0007.

## Behavior

- The public player shell and shared `/ui/assets` bundles contain first-party code. Core metadata, loader/WASM and game/save bytes use the existing bearer/local-trust read gate; no query tokens or cookies are introduced. `/ui` policy remains unchanged; only `/play` admits Blob/WASM execution.
- Source play requires current `local` availability and the supported system. Complete bounded byte collection happens before core import. Asset play uses successful blob collection as preflight, since asset manifests carry no availability field.
- Sources have no durable item association. Saves require an explicit existing item in the source’s known library/system. Titles are never matched implicitly; source playback without saves is allowed.
- Compatible single-file SRAM is staged before main. A user-selected compatible slot-0 state is staged and restored through an actual completed load command. Conflict copies require explicit selection and are never automatically adopted.
- Fixed command acknowledgements gate save snapshots. Timeouts quarantine the runtime; failed startup requires reload. Failed uploads retain bytes/key/base for retry/export. The loaded gameplay baseline is retained across phone writes and conflicts, keeping both histories through the existing API.
- Stop navigates out of the document. There is no generic in-document native exit/restart contract or promised asynchronous unload upload.

## Evidence and remaining acceptance

Generated controller/runtime fixtures and a real-API regression cover protected byte loading, staging, delayed completion, exact reply grammar, failure/timeout refusal, retries, read-only export and repeated stale-revision keep-both with retrievable phone/browser history. Generated files contain no real game/core/save content.

Real NES rendering, audio, input, SRAM/state roundtrip and bearer-only reverse-proxy operation with an operator-built pinned pair remain manual acceptance. The exact proposed SDK/frontend/core combination has not been built or verified here. Broader systems, native emulation, archives, multi-disc content, BIOS-dependent games, threading, workers/worklets, split SRAM/RTC files and arbitrary device save-state formats remain outside this profile.
