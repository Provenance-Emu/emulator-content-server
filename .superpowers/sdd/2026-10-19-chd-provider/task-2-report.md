# CHD provider Task 2 report

Scope: server/CLI opt-in, shutdown lifecycle, generated native acceptance, CI and operator documentation. Work is confined to the assigned `codex/v1-chd-provider` worktree. No real media, committed binary fixtures, primary-checkout changes, push, PR creation or merge.

## Files and behavior

- `apps/server/src/app.ts`: optional `OpenServerOptions.chdmanPath`; portable `chdProviderOptions` runner injection; provider factory only when configured; ZIP remains the default; probe precedes catalog creation; provider/catalog cleanup on later startup failure. Fastify `preClose` cancels and joins the registry before waiting for active requests; `onClose` closes the catalog, including direct `app.close()` callers.
- `apps/cli/src/main.ts`: `serve --chdman <absolute-path>` and `ECS_CHDMAN_PATH`, flag precedence, missing-value rejection, help text and service option propagation.
- `apps/cli/src/service.ts`: optional nonsecret executable path survives per-user service argument serialization on all three platforms. Existing listen-policy decisions are unchanged.
- `packages/storage/src/chd-decoder.ts`: normal help exit 1 accepted only for startup help probes after structural argument support validation; extraction still requires exit zero.
- `packages/storage/src/chd-cache.ts`: late callers do not join an already cancelled flight. They join its cleanup/lock release, check their own cancellation, registry shutdown and original deadline, then retry without resetting the deadline. No foreign-lock recovery/stealing was added.
- Portable tests: `apps/server/test/chd.test.ts`, `apps/cli/test/chd.test.ts`, additions to CLI service and storage decoder/cache tests.
- Native test: `packages/storage/test/chd-integration.test.ts`; deterministic runtime temporary fixtures only.
- Native CI: `.github/workflows/chd-native.yml`, `scripts/chdman/build-pinned.sh`.
- Operator docs: `docs/operations/chd.md`, link/configuration note in `docs/operations/service.md`.

No OpenAPI, generated clients or schema changes; Swift tests are not applicable to this delta.

## Test-first RED/GREEN evidence

Commands used pinned Node 22.22.2 from `/Users/jmattiello/.nvm/versions/node/v22.22.2/bin`, pnpm 10.30.1, `login:false`.

Initial behavioral RED, before implementation:

```sh
pnpm build
node --test packages/storage/dist/test/chd-decoder.test.js apps/server/dist/test/chd.test.js apps/cli/dist/test/service.test.js
# tests 33, pass 30, fail 3
```

`/tmp/ecs-chd-task2-red.log` names the three expected failures:

- `optional CHD executable survives each service registration without credentials`: registration lacked `--chdman`.
- `CHD is opt-in and a configured missing decoder fails startup`: missing expected rejection.
- `valid command help with exit one enables the decoder`: compatibility probe rejected normal help status1.

After implementation, the same command passed33/33 (`/tmp/ecs-chd-task2-green.log`). Later tests exercise configured compatible/incompatible startup, CLI flag/environment/precedence/missing-value behavior, real entry upload and HTTP GET/HEAD/ranges/ETags, no decode before authorization/listing, cache reuse, and shutdown of an active real socket request with an injected portable native process.

The second full verify run found `disconnecting one bundle waiter leaves the other download alive` failing with `CHD operation cancelled` (tests 280, pass 278, fail 1, skip 1; `/tmp/ecs-chd-task2-verify-final.log`). Its timer allowed a second request to finish resolution after the first waiter had already cancelled a still-cleaning flight. A deterministic gated regression at the real bundle-open seam reproduced that failure before the fix:

```sh
node --test --test-name-pattern='late requester' packages/storage/dist/test/chd-cache.test.js
# tests 1, pass 0, fail 1: cancelled flight completed cleanup
# /tmp/ecs-chd-task2-race-red.log
```

The fix waits for the old promise, including lock/staging cleanup, then retries with the same absolute caller deadline. Four deterministic cases cover retry, caller cancellation, registry shutdown and deadline expiration. Existing first/last waiter, close, queue, cross-process lock and cleanup tests remain in place.

```sh
node --test packages/storage/dist/test/chd-cache.test.js packages/storage/dist/test/chd-decoder.test.js
# tests 46, pass 46, fail 0, skip 0
# /tmp/ecs-chd-task2-race-green.log
```

One intervening targeted run under severe shared-host load reported 43 tests/pass 38/fail 5; its log was overwritten by the subsequent46/46 run before individual failure details were retained. That failed run is not treated as a passing result. At inspection the host load average was 277.74 with unrelated Xcode builds active. Final verification status is recorded below separately.

## Actual native acceptance

Actual executable: `/opt/homebrew/bin/chdman`, resolving to Homebrew `rom-tools/0.289/bin/chdman`. Actual help banner:

```
chdman - MAME Compressed Hunks of Data (CHD) manager 0.289 (unknown)
```

```sh
ECS_CHDMAN_PATH=/opt/homebrew/bin/chdman node --test packages/storage/dist/test/chd-integration.test.js
# tests 1, pass1, fail 0, skip 0
# /tmp/ecs-chd-task2-native-final.log; repeated after cache fix below
```

Generated noisy DVD: 41 sectors of 2048 bytes, `createdvd`, exact full SHA256 and nonaligned range comparison after provider extraction. Generated mixed CD: four separate source tracks concatenated on extraction, with 79 MODE1/2048, 83 AUDIO, 87 MODE1/2352 and 91 MODE2/2352 frames. All four advertised modes pass whole-byte SHA256 comparison including audio and raw sectors. Canonical CUE references exactly `disc.bin`, has entry IDs 0/1, correct modes and INDEX 01 positions 00:00:00,00:01:04,00:02:12,00:03:24. Exact group sizes, both logical entry reads, nonaligned ranges, and unchanged cached artifact mtime/path on reuse are checked.

The actual configured tool also creates an uncompressed temporary copy of the generated CD. `addmeta` constructs excluded declarations on those real codec/maps: pregap, postgap, subchannels, unsupported mode, multisession, legacy CHCD/CHTR, GD-ROM CHGD/CHGT, hard disk, AV/laserdisc and conflicting disc kind; all reject before decoding. Generated header changes test parent dependency/older version; the real CD exposed as a window rejects nested use. The first attempt to add metadata directly to a compressed CHD failed with native `File not writeable`; the fixture now uses native `copy -c none`, then `addmeta`. No production scope was reduced.

```sh
ECS_CHDMAN_PATH=/does-not-exist node --test packages/storage/dist/test/chd-integration.test.js
# tests 1, pass 0, fail 1, skip 0
# CHD decoder configuration: executable is missing or not executable
# /tmp/ecs-chd-task2-missing-native-red.log
```

That intentional failure verifies configured native acceptance never silently skips. With the path omitted, ordinary matrix execution reports an explicit local-native skip.

## CI pin, source and build rationale

Dedicated `CHD native acceptance` job runs on `macos-15`, separate from the existing portable Linux/macOS/Windows matrix. It sets `ECS_CHDMAN_PATH` to the built/cached executable unconditionally, checks nonempty/executable before running native tests, and cannot succeed by skipping absent configuration.

- Version: MAME 0.289, tag `mame0289`.
- Official source archive: `https://github.com/mamedev/mame/archive/refs/tags/mame0289.tar.gz`.
- SHA256: `0929cc749afabcef892900e10dd90bd8b05f94a7dde8f367ac6a5d2082589f84`.
- Checksum provenance: installed Homebrew rom-tools 0.289 formula at `/opt/homebrew/Cellar/rom-tools/0.289/.brew/rom-tools.rb`, which produced the locally accepted binary. The script checks this exact digest before extraction/build.
- Build: `brew install asio pkgconf flac sdl3 utf8proc zstd`, then `make -j3 TOOLS=1 EMULATOR=0 OSD=sdl3 USE_LIBSDL=1 USE_SYSTEM_LIB_EXPAT=1 USE_SYSTEM_LIB_ZLIB=1 USE_SYSTEM_LIB_ASIO=1 USE_SYSTEM_LIB_FLAC=1 USE_SYSTEM_LIB_UTF8PROC=1 USE_SYSTEM_LIB_ZSTD=1 PYTHON_EXECUTABLE=python3`.
- Rationale: uses the installed upstream formula's tools-only build flags; `EMULATOR=0` avoids an emulator build. The upstream top-level makefile does not expose a direct `chdman` target, so the tools build produces it and only `chdman` is retained/cached. The cache key includes version, macOS image, architecture and installed dependency-version digest.
- Source/build instruction cross-check: official tag makefile `https://raw.githubusercontent.com/mamedev/mame/mame0289/makefile`, official build documentation `https://docs.mamedev.org/initialsetup/compilingmame.html`.

The CI source build has not been executed locally or observed on GitHub in this task; controller CI must establish that result. Local native acceptance uses the already installed 0.289 tool. Native Linux/Windows acceptance is not claimed; the optional provider uses cross-platform process APIs and portable runners, while the dedicated native CI job currently targets macOS only.

## Self-review and remaining limits

Reviewed the complete delta for dependency edges, resource lifetime, native exit semantics, capability truthfulness, source paths, HTTP route reuse, service quoting, test temporary cleanup, and cache cancellation/lock behavior. Existing entry routes remain unchanged: authorization precedes entry lookup, and source containment/offline checks use the established readers. Existing exposure-policy and authorization tests run in full verify.

Operator documentation explicitly describes supported CHT2 modes/subset, shared compressedSize semantics, IDs and canonical paths, no RVZ/CISO/nested/browser-disc acceptance claim, optional configuration, lack of durable cache eviction/automatic crash reaper, and native execution limits. Direct native execution is not an OS filesystem/memory sandbox; polling may overshoot disk budgets and a compromised decoder retains server-user host access. The exact `.lock/` recovery path and requirement to stop all writers before manual removal are preserved. Valid cache remains readable; missing/invalid groups behind abandoned locks fail after bounded wait. No foreign locks are stolen.

## Final verification and commits

Implementation commit: `c9caf1883868bb5b4fba704b15bfffab30c14f48` (`feat: enable optional CHD decoding in server and CLI`). This report is committed separately afterward.

Final required checks:

```sh
pnpm verify
# exit 0; /tmp/ecs-chd-task2-verify-post-race.log
# main tests 284, pass 283, fail 0, skip 1 (native path unconfigured)
# web tests 6, pass 6, fail 0
# tray tests 8, pass 7, fail 0, skip 1 (existing platform-specific launch test)
# lint, both Svelte checks, generated drift, secret/fixture scan, boundaries passed

ECS_CHDMAN_PATH=/opt/homebrew/bin/chdman node --test packages/storage/dist/test/chd-integration.test.js
# tests 1, pass 1, fail 0, skip 0
# /tmp/ecs-chd-task2-native-post-race.log

git diff --check
# exit 0
sh -n scripts/chdman/build-pinned.sh
# exit 0
```

Final Svelte checks reported zero errors with existing initial-state capture warnings in `apps/web/src/Roots.svelte` (two) and `apps/tray/src/Panel.svelte` (one); these files are unchanged. The final lint run has no new warnings. No Swift/contract/client changes and no tray Rust changes, so neither Swift nor tray Rust compilation was run for this delta. Native source-build CI is pending controller execution; it is a material verification boundary, not a claimed passing build.

An earlier complete verify run before the late-join regression also passed main tests 280/pass 279/fail 0/skip 1 (`/tmp/ecs-chd-task2-verify.log`); the later failing 280-test run and intervening load-sensitive failures are disclosed above. The final post-fix result is the 284-test run.
