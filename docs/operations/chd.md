# Optional CHD disc entries

The default server supports ZIP only and runs no native decoder probe. Enable CHD with an operator-owned absolute executable path:

```sh
ecs serve --data ./content-data --chdman /absolute/path/to/chdman
ECS_CHDMAN_PATH=/absolute/path/to/chdman ecs serve --data ./content-data
ecs service install --data ./content-data --chdman /absolute/path/to/chdman
```

The flag takes precedence over the environment. Service registration persists this optional nonsecret path in its argument array on macOS, Linux and Windows; it does not inherit credentials or the interactive shell's environment. Embedded servers use `openServer({ dataDir, chdmanPath })`. A configured missing, nonexecutable or incompatible decoder fails startup clearly. The server probes `help extractcd` and `help extractdvd` once, accepts normal help exit status 0 or 1 only with required argument support, and advertises `chd` only after successful configuration. Listing reads bounded metadata without running the decoder. Normal entry authorization, source containment and offline-source checks remain in force.

Use a trusted, maintained MAME `chdman` with `extractcd -ob` and `extractdvd`. Generated native acceptance has passed with MAME 0.289 on:

- macOS arm64: local Homebrew rom-tools and the dedicated macOS 15 CI build from official source, including HTTP, cancellation and restart tests.
- Linux arm64: a local Debian bookworm Docker build from the same official source, including HTTP, cancellation and restart tests. The dedicated Ubuntu 24.04 x64 job builds that source too; its CI result is recorded separately from the local arm64 result.
- Windows x64: CI extracts `chdman.exe` from the official release archive after verifying its pinned SHA256. Generated DVD and all four mixed CD modes, HTTP and restart tests passed. Deterministic POSIX suspension/cancellation tests explicitly skip there.

The native source archive and Windows release archive have pinned SHA256 checks. All native jobs require the configured decoder and select both storage and HTTP acceptance tests. Missing/incompatible tools fail these jobs. Debian bookworm's packaged MAME 0.251 lacks the required DVD commands and is unsuitable. Ordinary Linux/macOS/Windows unit tests use a portable injected process runner and do not require a native executable.

## Supported logical views

Only standalone, parent-independent CHD v5 is accepted:

- DVD marker plus aligned 2048-byte units: entry `0` is `disc.iso`, the exact extracted sector image. This does not assert ISO9660 contents.
- Modern CHT2 CD metadata, one session, zero pregap/postgap, no subchannels: entry `0` is `disc.cue`, entry `1` is one concatenated `disc.bin`. Supported track modes are MODE1 (2048 bytes), MODE1_RAW (2352), MODE2_RAW (2352), and AUDIO (2352). The canonical CUE references only `disc.bin`, preserves modes and cumulative INDEX 01 frame offsets, and excludes CHD internal track padding. All four modes are exercised together with deterministic generated noisy bytes in native acceptance.

Legacy CD metadata, GD-ROM, multisession, nonzero gaps, subchannels, other track modes, older headers, parent/delta images, hard disk/raw/laserdisc CHDs and nested CHDs are rejected. RVZ, WIA, GCZ and CISO are not provided. CHD decoding does not prove browser disc-core playback; a consumer must fetch both CD artifacts and mount them together before opening the CUE.

GET/HEAD, ordinary/suffix ranges, range failures and ETags use existing entry endpoints. HEAD can materialize the complete group on first access. Each entry's `compressedSize` is the shared complete CHD size, not a disjoint allocation; do not sum it to estimate physical storage. CRC is unavailable. `method` is `chd-dvd` or `chd-cue-bin`.

## Cache, shutdown and recovery

One extraction publishes the complete immutable artifact group and hash manifest atomically under representation version `chd-v1`. Concurrent CUE/BIN requests join the group, valid cache is reused, and failed or cancelled active staging is removed. Shutdown initiates native cancellation before waiting for active HTTP requests, then joins provider and cache jobs. Cache byte capacity/eviction and automatic crash-leftover garbage collection are not implemented.

Cross-process writer locks never expire or get stolen based on age. The lock path is:

```
<cacheRoot>/virtual-cache/<outer-SHA256>/bundles/<group-key>.lock/
```

`group-key` is SHA256 of `JSON.stringify([outerSha256, "chd", "chd-v1", "disc"])`; the published group is the same path without `.lock`. A valid cached group remains readable without the lock. An abandoned lock with a missing/invalid group makes requests wait until their existing bounded deadline and fail.

To recover, stop **all** content-server/cache writers using that cache root, confirm no paused writer can resume, remove only the abandoned `<group-key>.lock` directory, then restart. Never remove a live or foreign lock based on its mtime. Inspect and remove crash-leftover partial directories only with all writers stopped.

## Native execution limits

The provider enforces bounded header/metadata reads, preflight expanded-byte/ratio/entry quotas for the complete group, one active decoder, eight queued distinct groups, shared declared in-flight byte reservations, one deadline, bounded logs, output-overrun detection, exact-size and descriptor/hash acceptance, and cancellation with termination escalation and joined exit/streams. Requests supply no executable switches or output paths. The native command uses an argument array and private staging directory without a shell.

This direct native process is **not an OS filesystem or memory sandbox**. It runs with the server user's filesystem access and native heap rights. Polling staged output can overshoot its byte budget between checks. For hard disk/memory containment, deploy a separately constrained worker/OS quota boundary. Private cwd, monitoring and cleanup do not supply that boundary.

## Generated acceptance

```sh
pnpm build
ECS_CHDMAN_PATH=/absolute/path/to/chdman node --test packages/storage/dist/test/chd-integration.test.js apps/server/dist/test/chd-native-acceptance.test.js
```

With no path these optional local tests explicitly skip; with a configured missing/incompatible path they fail. Tests synthesize DVD and mixed-track CD bytes and excluded metadata in isolated temporary directories, compare exact whole hashes/nonaligned ranges, CUE paths/INDEX offsets, both entry IDs and cache reuse. HTTP acceptance uses the production native process runner and a real loopback listener for authorization, cold HEAD, whole/suffix/nonaligned ranges, 416 responses, ETags, concurrent group requests and server restart reuse. A test observer counts actual native children; POSIX tests suspend the real child, confirm its stopped OS state, then verify last-request disconnect and shutdown join child exit before staging/lock cleanup and subsequent reuse. Cleanup resumes and terminates any leftover child. Those deterministic suspension/cancellation cases explicitly skip on Windows; portable injected-runner lifecycle tests still run there. No game media, native tool or binary fixtures are stored in this repository.
