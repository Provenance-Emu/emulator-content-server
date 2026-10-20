# ADR 0008: Isolated browser-static player assets

ADR 0007 continues to govern executable plugins, their host process and secret-bearing plugin directories. The content server never loads `plugin.json`, imports a player plugin, mounts a plugin directory or executes operator JavaScript in Node.

Browser playback is a narrow static distribution exception: the operator may configure a separate `playerDir` containing only one manifest and a pinned trusted loader/WASM pair. The server validates containment, regular files, size caps, exact profile and SHA-256 hashes at startup, then retains immutable buffers. Fixed read-protected routes expose only that pair. This adds optional `features.webPlayback` for browser-static availability, not plugin-host capabilities.

A separate first-party `/play/` document imports the authenticated-prefetched loader from a Blob URL and supplies authenticated-prefetched WASM/game bytes. It reuses public `/ui/assets` bundles. The extra Blob/WASM/COOP/COEP policy belongs only to `/play/`; `/ui` retains its existing CSP. Workers, inline scripts and JavaScript eval remain forbidden. Operator code runs with the browser origin’s authority, including session access, so trust in the build is required; neither hashing nor CSP is a sandbox against malicious core code.

The initial command-reply-v1 profile is restricted to single-thread FCEUmm NES with single-file SRAM and compatible slot-0 states. Completed command replies gate file snapshots. A timeout requires a fresh document, and Stop leaves the document rather than invoking an unverified generic native shutdown API. Upload retries retain the original body/key/base; device concurrency uses the existing keep-both API, without refreshing another device’s revision into the gameplay baseline.

Generated fixtures establish wiring and API behavior. An actual operator-built pair and lawful NES program must still pass the build and manual acceptance described in [operations](../../operations/browser-playback.md). No core binary, nightly download, emulator content or fabricated artifact hash is committed.
