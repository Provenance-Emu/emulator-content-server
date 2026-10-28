# Handoff

## ROM matching and shared UI — 2026-10-27

Pushed matching b4e9a5c and UI ecc17be directly to main with skip-ci commits. Matching now handles legacy years/scene tags/articles/localized aliases, uses No-Intro/Redump plus Jaguar TOSEC and Atomiswave DAT, parses Flycast identity facts for Naomi/Naomi2/Atomiswave short set names and GD-ROM serials, and offers board-aware suggestions for unknown arcade sources. Board ambiguity is preserved; filename evidence never becomes checksum confidence. Artwork comes independently from complete thumbnail Git trees with correct branches, immutable revision URLs, placeholder filtering, cover preference and title/snapshot fallback. Jaguar CD uses the shared Jaguar artwork collection. Failed auxiliary catalogs preserve healthy candidates and a retryable provider problem.

Public catalogs use a bounded six-hour disk cache under dataDir/cache/matching-catalogs (404 ten minutes), with private hashed filenames, no-follow reads, atomic writes and verified body hashes. Matching/provider code still runs in the separate child process with no bearer environment. No protocol change or migration.

The operator LaunchAgent now runs dist-release/0.1.3-matching/server/dist/src/main.js against the same content-data and 127.0.0.1:8473. Preserve this ignored deployment plus earlier deployments and user data. Service startup took longer than the first six-second probe; it became healthy, doctor reports integrity ok/bootstrap complete, and the actual HTTP API returned metadata and authenticated PNG previews for Atari Karts, Baldies, Crazy Taxi, mvsc2, gds-0014, kofxi and previously unknown Slashout. Eight direct public-provider/image checks also passed, including Alien vs Predator and Dead or Alive 2. Public caches were primed from 13 already validated official-catalog entries. No operator selections or original files were changed. User was told current desktop app can test this through Match library; no new DMG was built.

Validation: 34 focused matching/cache/child-process/server tests passed; final cache lint/type fix reran 9 cache tests; boundaries/secret scan/type build/lint pass. Dedicated UI agent ui_design_system delivered semantic root tokens/compatibility aliases, shared Tabs and navigation/action styling; migrated Storage/FolderPicker/Settings/Locations/category tabs and documented docs/ui/design-language.md. 220 UI tests, web build, both Svelte checks and 2 generated desktop/phone browser checks pass. Parent independently reran the two visual/keyboard/theme/no-write browser checks and tray Svelte 0/0. Server web UI contains these design changes; installed native 0.1.3 alpha2 retains its bundled UI until the next installer refresh. Reuse the UI agent for later bounded design work; it did not modify matching/server code.

After this batch, inspected Emscripten/WASM plugin support and documented docs/operations/web-emulation-plugins.md. Existing player manifests inventory only a WASM module and are disconnected from the pinned NES browser runtime. Next implementation should use validated data-only profiles and a credential-isolated browser launcher/channel before admitting third-party loader JS. No additional core or unsafe plugin execution was enabled. Some legacy PD/homebrew/prototypes still lack catalog or art coverage; do not invent matches or silently apply filename suggestions.

## Latest usable build — 2026-10-27

v0.1.3-alpha.2 freezes a8d33d8 (same numeric 0.1.3). Its Mac DMG is signed, notarized (cfbc1ff3-c3fc-4948-a136-5bd6094f3b06 Accepted), stapled and published. Installed binary matches the signed build and Gatekeeper accepts it. Actual reopened app restored its managed profile, opened the native OS folder dialog without clicking Use local managed service, and canceled without data changes. Eight focused desktop-folder tests pass, including three new restore/manual-switch regressions. All five published installer/archive digests match their SHA-256 files. Windows 40618089326 and Linux 40618092177 packaging succeeded; DMG, MSI, DEB, AppImage and portable archive are published. Portable server code is unchanged from alpha1 and its verified archive is reused under the alpha2 filename. Local LaunchAgent stays on dist-release/0.1.3/server; its data, profiles, sessions and 935 indexed games remain intact.

Do not spend another pass on installer restructuring. Requested UI/storage/folder behavior is shipped. Remaining product work includes arcade metadata/artwork provider coverage (Atomiswave/Naomi/Naomi2); scanning and existing Dreamcast provider matching were separately verified. New low-severity GitHub alert 50 names deepmerge prototype poisoning; follow up proportionately after the UI batch rather than holding these installers. Source checkout is main; no new branches/worktrees were created.

## Installer refresh — 2026-10-27

Published v0.1.3-alpha.1 at 1466d1c with notarized/stapled Apple Silicon DMG and portable Node22 archive; digests match GitHub. Notary 6ca0ab99-6cb3-4fb9-adb5-bacb0c404bc2 Accepted. Windows/Linux packaging runs 40617312157/40617311759 both succeeded; all five installer/archive digests match published SHA-256 files. Installed /Applications/Emulation Server.app 0.1.3 passes Gatekeeper and actual Storage/native-dialog open/cancel acceptance. Local LaunchAgent now points to dist-release/0.1.3/server and retains the same content-data and 127.0.0.1:8473. Doctor reports integrity ok. Preserve both ignored deployments and operator data.

Remaining startup UX bug found during live acceptance: a restored managed-service profile starts with no fresh native receipt, causing the server-folder fallback until Use local managed service is clicked. Fixed automatic native verification on restore with stale-context/manual-profile protections. Managed controllers wait until verification and a fresh context retires old adapters before enabling the native dialog. Three new reload/manual-switch regressions plus five existing desktop-folder browser cases pass; tray Svelte and frontend build pass. This follow-up will use v0.1.3-alpha.2 without changing numeric versions. First frozen release artifacts are not replaced.

Validation: 220 web tests; both Svelte checks 0/0; 23 tray tests and one platform-specific skip; 30/32 combined browser cases passed initially, two desktop cases passed on immediate targeted rerun, followed by all 5 desktop-folder tests passing after closing context in test teardown. New orphan/scan failure regressions pass. Portable production startup/UI/assets test 3/3; boundaries/secret scan/diffcheck pass.

## Storage/library UX pass — 2026-10-27

Implemented Storage tabs (server folders/uploaded files/mounted remote storage), compact desktop folder chooser/controls with touch sizing retained, explicit orphan-folder linking on home/empty library/settings, automatic scanning after assignment, duplicate-path reconciliation, native duplicate-orphan action, always-available per-folder scan, and a never-scanned library callout. Failed scans after linking remain visible and can be retried in the destination library without registering/assigning again. A reused design agent reviewed desktop/mobile visuals, tab keyboard/focus behavior, no writes on browsing, and assignment lifecycle.

Operator's two saved roots were already assigned to the default library but had never been scanned. Requested metadata scans indexed 1,608 files into 935 game entries; no original files were moved or modified. A read-only online provider lookup for an actual Dreamcast source returned attributed filename metadata/artwork candidates. Atomiswave/Naomi/Naomi2 provider coverage remains limited; do not claim a scan provides complete artwork/metadata matching. Public upstream DAT availability and format were inspected; no speculative provider mapping or unsafe checksum substitution was added.

## Active continuation — 2026-10-27

Implemented opt-in IndexedDB upload checkpoints, full bounded SHA-256 file verification/reselection, original transfer key/revision preservation, write-ahead creation intent and conservative crash reconciliation. Session/server/library/game scopes use an opaque credential digest; no file contents or raw credentials are serialized. Logout purges records and warns on a failed cleanup. Broken storage has an explicit temporary-queue fallback. Atomic per-key revision counters survive discard/recreate to prevent stale-tab ABA overwrites. See docs/operations/upload-recovery.md. Focused queue/fingerprint tests, real IndexedDB tests and real-server reload/access tests pass; full web controller suite passed 216 tests. Existing target-picker test had assumed a random UUID sorted onto page one; fixed it to navigate bounded pages.

User steering now prioritizes confusing libraries/storage, oversized desktop buttons, poor web folder picker sizing, offering existing unassigned folders instead of duplicate registration, and scanner matching. Agent audience_ux owns FolderPicker/app.css plus SettingsShell/new StorageSettings/Locations copy and relevant navigation-test lines. Parent owns orphan-link prompt, SettingsLibraries mode, folder controller/scan behavior and scanner/provider diagnosis. Do not autoassign or delete operator folders.

Read-only diagnosis found both operator roots already assigned to the default library but never scanned (zero index, unknown scan state). User-requested scans succeeded for both: 1,608 indexed files and 935 game entries across Jaguar/JaguarCD/Dreamcast/Atomiswave/Naomi/Naomi2 (two unknown systems). No ROM file contents were copied or altered. Make assignment scan automatically and expose scanning for existing never-scanned folders, then check metadata/provider matching separately. Active service/deployment from 0.1.2 remains unchanged and must be preserved.

## Installed UI refresh and download follow-up — 2026-10-26

Published `v0.1.2-alpha.1` from `4492c56`: new UI in macOS arm64 DMG, Windows x64 MSI, Linux x64 DEB/AppImage, and the Node22 portable archive. Manual package jobs `40419078897` (Windows) and `40419082380` (Linux) succeeded. All five installer/archive GitHub digests match the downloaded checksum files. macOS notary submission `361ed6f7-84f8-4149-b50c-37b5a06efd6a` was Accepted; DMG/app stapling and Gatekeeper pass. `/Applications/Emulation Server.app` is now 0.1.2; previous copy moved recoverably to Trash and profiles/sessions retained.

The app's saved managed profile pointed at obsolete temporary port 62844. The existing repository `content-data` catalog passed doctor (already bootstrapped, integrity ok), and was started as the user's fixed managed service at loopback-only `127.0.0.1:8473`. Native Use local managed service reverified the real process/listener and connected the new UI. The actual OS folder picker opened and canceled; no folder was confirmed or upload attempted against operator data. The service is intentionally left running. **Preserve `dist-release/0.1.2/server` even though ignored: the installed per-user LaunchAgent points at that deployed CLI.** Also preserve `content-data`, existing root registrations, credentials and all app profile storage.

Post-release source follow-up implements authenticated streaming to a browser Save File Picker through new filesystem-neutral client sink APIs. Strong ETag resume, reset on changed content/no validator, backpressure, 64 KiB writes and commit-only-on-completion; disk errors/auth rejection/cancel/stale navigation abort. Legacy downloads now cancel on disposal, precheck oversized metadata, and cap buffered content at 256 MiB. ZIP fallback also bounds headers and actual bytes. Chrome/Edge need HTTPS or localhost; WebKit and LAN HTTP retain the bounded fallback. No protocol contract/migration/Swift change. These later download changes are on main for the next release, not in 0.1.2 installers.

Validation: 92 client tests, 207 web controller tests and 22 focused browser cases pass; both Svelte checks, root TypeScript check and web/tray builds pass. Browser tests mock only File System Access picker/writer, use real ephemeral HTTP for authentication/content, and do not claim actual Chromium OS writer acceptance. Proportionate review found the original unlimited fallback, now fixed; final reread found no further substantive issue.

Remaining product work: persistent upload queues across reloads, native streaming destinations for WebKit/other browsers, and broader core/app integration acceptance. Queue persistence needs explicit permission/file-identity recovery and per-account storage semantics; don't serialize File objects, raw tokens or blindly resume a different reselected file. npm publication still lacks registry login; Linux GTK/glib advisory requires an upstream dependency-stack upgrade. Intel remains deprioritized. Keep release refreshes scoped and preserve the active service's ignored deployment when cleaning artifacts.

## Approachable library implementation — 2026-10-26

Completed the design agent's journey-based UI batch on main: actual Home library cards/Create action, first-library guidance, Add games chooser with device versus server explanations, useful permission-aware empty states, mobile optional filters, identifiable missing covers, top-level supported Play, unsupported download guidance, readable phone download rows, helpful account entry, and collapsed desktop connection controls. Empty collections no longer show useless pagination. Detail headings use actual console names and omit internal revision counters. Native shell/process/service semantics are unchanged; default desktop placeholder is corrected to CLI port 8473.

Manual reconnect now works before sign-in. The controller still gates private discovery on initial/restored authentication work or an established signed-in state, coalesces retries, and rejects obsolete epochs. A meaningful new regression reproduces failed-startup retry and verifies a later sign-out cannot restore private access. Proportionate agent review found no substantive auth/concurrency problem.

Validation: 62 browser cases passed, then 17 final targeted cases passed after strengthening upload-denial assertions to inspect the actual import chooser. Design agent ran 10 desktop/UX cases. Web/tray controller suites, both Svelte checks (0 errors/0 warnings), frontend builds, lint, boundary and secret checks passed. New tests cover phone home-to-library, complete first import, reader permissions, retry, empty-home cancel, and server-folder unsupported play. Real generated-fixture screenshots and journey evidence are in docs/superpowers/specs/2026-10-26-approachable-library.md. These are heuristic design/automated acceptance, not sessions with actual teenage/older participants.

The UI source changes are not yet in published 0.1.1 installers; avoid silently presenting those binaries as containing this later UI. Do not spend the next product pass on another OS matrix. Remaining product limits are browser memory-heavy downloads, upload queues lost on reload, broader emulator/profile acceptance and app-side adapters in their own repositories. npm authentication and Linux upstream GTK/glib advisory remain external/dependency follow-ups; Intel is deprioritized. Primary checkout stays main.

## Product usability and notarization — 2026-10-26

User prioritizes useful, approachable product flows over further distribution work. Design work considers both novice teenagers and nostalgic older users: visible click/tap controls, useful home/empty states, clear import choices and direct Play/download actions. Intel builds are explicitly deprioritized.

Apple accepted the published 0.1.1-alpha.1 Apple Silicon DMG (submission `cdb7b615-748e-44cb-90ad-a60d097cfb77`). DMG and installed app were stapled successfully; Gatekeeper reports accepted / Notarized Developer ID. The existing release DMG and checksum are replaced with the stapled bytes. Reuse the existing local App Store Connect key outside the repository; never print the key or generated tokens.

## Desktop and deferred pass — 2026-10-26

Published desktop alpha 2 at `4207a79`: macOS Apple Silicon DMG (Developer ID signed, not notarized), Windows x64 MSI and Linux x64 DEB/AppImage. Both manual native artifact jobs succeeded; optional test matrix was skipped as requested. Product/app/window/default-server display names are now Emulation Server; auth realm, bundle ID and fixed service registrations are unchanged. An inert-icon report led to a Rust startup menu independent of hidden webview initialization and a visible error fallback. The installed renamed app is `/Applications/Emulation Server.app`.

The deferred desktop browser teardown is fixed by closing browser contexts before server fixture teardown; completed download bytes are now checked. Nine focused desktop/access/player browser cases, 26 Rust fixtures, 23 tray controller tests and 29 server/CLI cases passed. Fastify/fast-uri/esbuild were updated and the audit reports zero vulnerabilities. Docker was built from the release commit and passed live health/UI/assets checks in a disposable container with an ephemeral port. Colima was started only for that check and then stopped; Docker's original default context was restored. npm publication is blocked by missing registry login. macOS notarization and Intel builds remain deferred.

Follow-on 0.1.1 adds safe per-user device token listing/creation/revocation and current library membership display/editing through additive API routes and generated TS/Swift models. No migration. Credentials are shown once and read-only reconciliation retries prevent duplicate token creation after a lost refresh. Swift's default PATH resolves an obsolete 5.3 toolchain; use `/usr/bin/xcrun swift test --package-path clients/swift` (Xcode Swift 6.4), which passed seven tests.

0.1.1 is published as `v0.1.1-alpha.1`, target `c470fd8`, with a tested portable archive and signed Apple Silicon installer; Windows/Linux artifact jobs were dispatched for that release. All eleven focused access/device/membership browser cases, both new API regressions, protocol checks, full web/tray controller/typechecks, seven Swift tests, lint/drift/boundary/secret checks pass. Exact extracted archive startup/UI/assets plus membership/device-token lifecycle pass. The remaining GitHub dependency alert is moderate `glib::VariantStrIter` unsoundness in Linux GTK's glib 0.18.5 (GTK 0.18.2); JavaScript audit remains zero. Do not misreport the JavaScript audit as covering Rust.

Final 0.1.1 publication: Windows job `40414378561` and Linux job `40414381570` both succeeded. DMG, MSI, DEB, AppImage, portable server and platform SHA-256 files are uploaded. The installed `/Applications/Emulation Server.app` is signed version 0.1.1 and was reopened through Finder; the previous Content Server Status application was moved recoverably to Trash. Profile/session data was preserved. Primary checkout remains on clean main.

## First-version shipping pass — 2026-10-26

User direction: no prompts/confirmations, push directly to main, skip CI, use focused local TDD, and record slow/blocking work for a later pass. Use subagents sparingly and reuse a session for related work. Complete one fast pass before expanding scope.

Web settings now expose account/password/network policy administration and library reader/editor assignment/removal. Guest/device tokens can sign in without URL credentials, including player setup. WebDAV-enabled servers expose per-account app credential issuance/revocation to signed-in accounts. Canceled login responses cannot change the active application credentials. Portable bundling includes the UI and protects existing output directories even with ambient force settings; Docker uses the same bundler.

See [first-version status](../docs/operations/first-version.md) and the [completion evidence](../docs/superpowers/plans/2026-10-26-first-version.md). The portable alpha is the initial downloadable artifact; npm, signed native installers and hosted images remain follow-ups. The existing desktop browser test completed assertions but timed out in fixture teardown. Docker daemon was unavailable. Do not delay this iteration for the full CI/native/Swift matrix or revisit already accepted pinned NES playback from stale notes below.

## Current checkpoint — 2026-10-21

The sections below this checkpoint are historical. Scanning, the library browser,
and library-folder management have since landed. Device-folder selection, bounded
upload review, and a resumable sequential queue are now implemented. Do not
restart those features from the old “Next” list or treat its uncommitted-work
description as current. Consult the source and operations guides for implemented
behavior.

The current user direction is to continue library and matching improvements,
batch changes directly on `main`, and commit/push completed work. The project is
still unreleased; use focused checks and create PRs only when requested or needed
to isolate colliding parallel work. The branch audit found only local/remote
`main`, one checkout, and no open PRs.

Recent work includes saved metadata/artwork/patch/cheat selections, library-wide
checksum matching and its review queue. Partial provider failures now remain
reviewable and also appear under Failed, where they can retry without repeating
healthy games or replacing saved choices. Completing review clears retry status.
See [Matching operations](../docs/operations/matching-plugins.md).

Completed work adds in-panel recovery for transient saved-match loading errors,
opens populated suggestion categories while preserving a useful tab selection,
and fixes switching between single/multiple system filters and filtered empty
states for system chips.

Matching now recovers provider-list failures, reconciles uncertain save/removal
responses, blocks writes until failed reconciliation is retried, and rechecks
concurrent selections between bulk auto-saves. The TypeScript client's empty
DELETE requests no longer advertise a JSON body, fixing Remove saved's HTTP 400.
Provider readiness respects the online setting. Refresh details updates current
source availability through bounded browsing without scanning folders.

Device file/folder uploads now use a 50-entry paginated metadata review and
sequential queue with 4 MiB chunks, visible successes, stop-after-current, and
retry of unfinished entries. Each attempt retains its created item, original
revision and transfer key, including after lost completion responses. Ordinary
LAN HTTP is supported. Unknown item creation requires explicit existing-item
reconciliation; the bounded target picker displays IDs and never guesses by name.
Library-level associated files require a managed target; detail uploads supply
one. Subsequent associated files refresh revisions while retries retain the
original save baseline. Folder uploads preserve safe relative paths. Queues and
selected files remain in memory only; they do not survive reloads. Owner-only
Add server folder reuses the registration/scan controller and retains scan retry.

Device-upload validation: 11 focused controller regressions and 12 real-server
Chromium upload cases pass, including multi-save detail queues, bounded selection,
relative folder paths, fallback, ordinary LAN HTTP, stable retry/reconciliation,
and authorization stopping. The full web controller suite passed 182 tests before
the final two focused regressions were added. Svelte check, production web build,
lint, secret scan and package boundaries pass. All 14 existing library browser
cases also pass, including busy-modal/focus behavior, preserved save adoption,
byte downloads, access revocation and isolated player navigation.

Prior checkpoint validation: 173 web controller tests, 36 TypeScript client
tests, 32 ZIP tests for the integrated corrupt-DEFLATE fix, Svelte check with zero
errors/warnings, focused matching/filter/detail/upload
browser regressions, TypeScript and production
web builds, changed-file lint, and package boundaries. This does not establish
native platform or real browser-core acceptance. Runtime notes below describe an
earlier operator setup; verify current configuration before restarting anything.

Desktop Tasks 6–7 are implemented on main: the bundled library window reuses the
shared web App, while status/service controls and Open in browser remain available.
Desktop sessions are scoped to canonical server origins and separated from browser
storage. Server switches and cross-window sign-out discard credentials/private
results; external player links retain only public selection IDs and support browser
sign-in. Desktop CORS includes the resume/revision headers required by the client.

Use local managed service derives the endpoint from native service/process/listener
inspection. Only verified managed profiles receive the native directory adapter;
manual/remote profiles keep the server chooser. Directory confirmation reuses the
existing one-register/one-scan flow, creation stages paths, and upload storage keeps
its current target. Native IDs bind owner/PID/birth/generation/listener and are
revalidated around the dialog and before submission. Windows falls back; Linux
verification is implemented with synthetic fixtures but not executed locally.

Desktop validation: 186 web controller tests, 21 tray tests (one Windows-only skip),
24 Rust fixtures, 3 server access/CORS cases and 7 isolated Chromium desktop/player/
folder checks passed across the focused runs. Svelte checks and macOS release app/
DMG builds passed. No managed LaunchAgent was registered on this Mac (read-only
probe exit 113); live native dialogs and Linux/Windows platform acceptance remain
unverified. The manual native CI matrix is available. Combined review found one
recovery bug: failed managed-service re-verification retained captured native
validators. Fix bf96e44 replaces the same-origin context with the server-chooser
lifetime and discards pending selections, resetting navigation. Three focused
regressions reproduce and cover that transition. Final publication status is in
git history.
External ZIP fixes ea61ef0 and a31c0ba were fast-forwarded into main; 40 focused ZIP
tests passed. Do not repeat completed desktop/upload features from historical notes.

Desktop acceptance follow-on: b194f2b adds macOS reopen handling for hidden
windows, verified in the real bundled WKWebView. Native browsing, server switch,
unreachable-profile clearing, server-folder fallback registration/scan, close/reopen
and browser URL handoff were exercised against disposable generated catalogs.
11c0206/96444e5/cfb1210 fix Windows compiled-fixture paths, the missing resource ICO
and a host-separator assumption in a simulated macOS test. Focused macOS/Linux
native CI passed, and the final Windows retry passed tray checks, all 24 native
fixtures and release compilation. Runs are linked in the acceptance guide. Live
verified-local directory dialogs remain unverified because the LaunchAgent is
absent. Native download completion and upload after file-picker selection remain
unverified due native automation limits; do not relabel Chromium tests as native
passes. See docs/operations/desktop-acceptance.md for exact evidence.

## Historical handoff

Read `AGENTS.md` before changing code. This file is the current gap, not a second architecture.

The page can register a ROM folder and then shows nothing from it. Registration is done. Scanning is not. That is the next feature. A visual pass on the existing forms will not make those folders useful.

## What the operator has running

`pnpm dev --tray -- --data ./content-data --port 7878` watches the tree, restarts the server when compiled server code changes, and opens the menu bar. The data directory is `content-data` in this checkout. If that directory has no owner yet, the token is `content-data/bootstrap.token` and the status window asks for it. Do not print that token.

Older demo processes used `/tmp/ecs-ui-demo` on 7879 and `/tmp/ecs-choice` on 7880. They are not the library.

## Done, and not all of it is committed

Committed on `main` through the sync and signing work: the v1 API, blob storage, ZIP reads, content roots (the path is saved, nothing is copied, nothing is scanned), keep-both saves, adopt, the web page at `/ui`, the menu bar shell, and the TypeScript and Swift sync engines.

Uncommitted in this working tree, and required by the running server:

- Local-network access. Default mode `lan`: this machine may manage accounts with no token, other private addresses may sync and may not manage accounts, and a public address needs a login. `subnets` adds named CIDRs. `token` requires a login everywhere. `--public` ignores the socket address because it is the proxy. The menu bar is the only cross-origin caller allowed to read responses.
- Menu bar forms for the owner account, other accounts, guest links, and that access rule. `apps/tray/src/Access.svelte`.
- `pnpm dev` in `scripts/dev.mjs`. A development web build overwrites `apps/web/dist`. Run `pnpm ui` before treating that directory as the production page.
- `docs/workstreams/media-availability.md` is a brief only. No probe, migration, or route exists.

Do not commit ROMs, BIOS, discs, or saves. The folders added from the page are rows in `content-data`, not files in git.

## Next, in this order

1. **Show the folders.** Implement the scan in `docs/workstreams/scanning-metadata.md` together with `docs/workstreams/media-availability.md`. A root stays a path. Files stay where they are until a client asks for bytes. Each file is `local`, `evicted`, or `offline`. An evicted file is `stat`ed and never opened, because opening it starts an iCloud download. Readers see availability, not the absolute path. Unplugged disks stay registered. This is not the storage-locations brief, which is about copies the server already owns.

2. **Replace the page.** `apps/web` is a stack of forms: status, upload, and a path field. After a scan exists, the page should be the libraries and the folders, with files grouped by system and kind, and conflict copies keeping the "Use this one" action already wired to `adopt`. The menu bar stays a status and access panel. It does not become the library, and it does not read the database. Rust stays the shell.

3. **Leave these until the library is visible.** Audit log page. Storage locations. Start-at-login. Disc containers after ZIP. WebDAV. Remote access and any relay. Sideload and JIT, which are specified in `docs/workstreams/sideload-installer.md` and stay out of the content-server process. App screens stay in the Provenance, iCube, and iFly repositories. In-browser play is [Web playback](../docs/workstreams/web-playback.md): libretro Emscripten cores the operator supplies, same accounts, same files, after a local file can be streamed. A container for a VM or cloud host is [Container install](../docs/workstreams/container-install.md). `compose.yaml` publishes loopback. A public port needs `token` mode and `--public --tls-terminated`, because the Docker bridge would otherwise look like the LAN.

## Rules that are easy to break

- New schema is a new numbered migration. Do not edit a migration that has already been applied. The catalog must open twice and keep its rows.
- OpenAPI changes are additive. Removing an operation or a property, or adding a newly required field, is a new major path. Regenerate with `pnpm generate` and update the surface only when the contract change is intentional.
- `packages/protocol` and `packages/domain` do not import Fastify, SQLite, or the filesystem. The tray and the web page depend only on `@ecs/client`. The tray may also use the web package for shared components.
- Never log a bootstrap token, bearer token, password, or authorization header. Audit details must not contain a raw token. Guest tokens are shown once in the menu bar and are not stored there.
- `pnpm verify` is the check. `swift test --package-path clients/swift` when the Swift client changes. The tray's Rust shell is `pnpm tray`, and it is not part of `pnpm verify`.
- The maintainer uses branches and worktrees and does not want a pull request unless they ask.
