# Desktop acceptance

## 0.1.6 refresh — 2026-10-28

Published [v0.1.6-alpha.1](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/v0.1.6-alpha.1) from frozen source `2e7705bcd838b21ebaf1f55f4fcb69784f1c9641`. The arm64 Mac app and DMG are Developer ID signed. Apple accepted app submission `03fde68c-8846-4afc-9a9c-748263d05292` and DMG submission `20830ae9-50ae-42fe-b4fb-17f6ead0928d`; both tickets validate and Gatekeeper accepts them. The Applications copy was replaced from that DMG, preserving the prior copy in Trash. Native accessibility inspection verified Home, the existing library and Library activity on the installed app.

Windows build [40746030277](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/40746030277) and Linux build [40746033801](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/40746033801) succeeded from the same source. All five uploaded binary artifact digests match the downloaded platform checksum manifests: DMG, MSI, DEB, AppImage and portable server archive. Windows/Linux GUI acceptance remains separate from packaging success.

The detached portable snapshot activated with the existing schema-18 catalog, roots, profiles, user sessions and saved choices intact. A private integrity-checked schema-15 backup exists for reverting to the older server; old binaries cannot open schema 18. The first shared matching pass completed 935 games in 15.636 seconds, added 29 metadata selections and preserved the existing artwork. ZIP inner-ROM and further coverage improvements are a subsequent main-branch batch, not changes to the frozen release bytes.

Use generated content and a temporary loopback server/catalog for interactive
checks. Never point an acceptance upload or folder-registration check at an
operator catalog. Build the bundled app with `pnpm --filter @ecs/tray tauri build
--bundles app`; `pnpm --filter @ecs/tray check` and the Rust fixture tests cover
controllers and fixed native boundaries separately.

## Emulator management refresh — 2026-10-28

[v0.1.5-alpha.1](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/v0.1.5-alpha.1) freezes5098224 with the native Emulators settings UI. Mac arm64 notarization0a66d41c-f866-4c3d-a1bb-a5668ef6fbfe was Accepted; app and DMG are stapled and Gatekeeper accepts the installed0.1.5 application. Windows40647340447 and Linux40647343652 packaging succeeded. All five installer/archive GitHub digests match downloaded checksum files. The previous Applications copy was moved recoverably to Trash.

The installed app restored its existing server profile, opened Home, and displayed Settings→Emulators with Installed/Available tabs and the accurate owner sign-in requirement. No credentials, user firmware, games or saves were entered or changed in this native check. Real-server browser tests separately cover owner package installation/configuration/removal and system-file controls. Verified Jaguar is installed in the local managed registry; the server is healthy with unchanged original catalog. Dreamcast-family runtime remains deferred as described in [management operations](emulator-management.md).

## Installer refresh — 2026-10-28

Published [v0.1.4-alpha.1](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/v0.1.4-alpha.1) from frozen source `2f1c869`. The Mac arm64 app/DMG are Developer ID signed; Apple accepted notary submission `f415818f-ae5c-4bb2-b89f-d70f44b354a9`. App and DMG tickets validate, and Gatekeeper reports Notarized Developer ID. The installed Applications copy reports 0.1.4 and its ticket validates; the previous app was moved recoverably to Trash. The installed app reopened with the existing local server profile, rendered Home and the existing 935-game library, and showed the new shared category/navigation controls. No test upload, folder registration, metadata selection or save was made against that catalog.

Windows packaging run `40637200521` and Linux packaging run `40637203044` both succeeded from the same tag. DMG, MSI, DEB, AppImage and portable Node22 archive are published; all five GitHub artifact digests match the downloaded platform/server checksum files. These are installer build checks, not live Windows/Linux GUI acceptance. Native Rust logic was unchanged apart from the version; both UI typechecks, 23 tray tests (one existing platform skip), 226 web tests and the focused UI/real-player checks pass.

The separately installed `org.libretro.fceumm` profile passed [real browser plugin acceptance](browser-playback-plugin-acceptance.md). No emulator or content binaries are embedded in the installers. The local LaunchAgent now uses the independent `dist-release/0.1.4/server` deployment and the stable operator player registry; data, profiles and sessions remain intact. The bundle script now detaches pnpm hardlinks before activation, preventing subsequent source builds from changing an installed snapshot. CLI help is also side-effect-free before service/data operations.

## Installer refresh — 2026-10-26

0.1.2-alpha.1 is published with the new shared library UI. Apple accepted the signed DMG (submission `361ed6f7-84f8-4149-b50c-37b5a06efd6a`); DMG and app tickets validate and Gatekeeper reports Notarized Developer ID. The installed Applications copy reports version 0.1.2. Windows and Linux packaging jobs succeeded; all five published installer/archive digests match their checksum files.

The real installed Mac app was reopened and its new Home, library, empty state, Add games chooser and collapsed connection controls were verified through accessibility. With the local service running, the native Add library folder dialog opened and Cancel returned to an enabled library without confirming a folder. No upload or folder-registration acceptance was performed against the operator catalog in this refresh. The older generated-fixture acceptance below remains distinct evidence.

## macOS checks — 2026-10-21

The release app was exercised through native accessibility automation, using two
isolated loopback servers with generated eight-byte content and an empty folder.

| Check | Result |
| --- | --- |
| Start hidden, then reopen from Finder/Dock | Found missing reopen handler; fixed and verified the bundled library window opens |
| Close library and reopen app | Passed; same library/selection remains available |
| Browse library and open generated game details in WKWebView | Passed |
| Switch between servers | Passed; A's collection/details disappear and B's libraries render |
| Switch to an unreachable profile | Passed; prior libraries/details clear and an unreachable-server message appears |
| Local managed-service verification without a registered LaunchAgent | Passed; sanitized unavailable message, server chooser retained |
| Add server folder through the real webview fallback | Passed; one generated folder registered, summary reports completed scan and zero files |
| Open in browser | Passed URL handoff to Safari at selected server's `/ui/`; this fixture did not mount browser assets, so browser-page rendering is covered by the separate browser tests |
| Native upload file picker and completion | Passed in bundled WKWebView: selected a generated four-byte save through the OS picker; review targeted the generated item; queue showed one succeeded and zero unfinished; fetching the saved asset matched all bytes with exactly one save entry |
| Native download destination and completed bytes | Found missing native download handler; fixed. Keyboard activation downloaded the generated eight-byte blob into Downloads; saved bytes matched exactly and the library remained usable |
| Real verified-local directory dialog selection/cancellation | Passed with a transient test LaunchAgent after confirming the service label was unused and no persistent registration existed. Settings and library quick actions opened the OS directory sheet; cancellation wrote nothing, each confirmed folder registered and scanned once |

The managed-dialog/transfer follow-up used a separate temporary catalog and generated files.
The native download handler accepts only same-origin library blobs into a direct
Downloads child and rejects existing entries. Operator catalogs and persistent
service registrations were not changed.
The transient service, test process, generated catalog and downloaded fixture were
removed after verification; the service label was absent afterward.

Focused follow-up checks passed: five desktop folder browser scenarios, eighteen
shared folder/browser controller tests, twenty-three desktop controller/resource
tests (one Windows-only test skipped on macOS), twenty-six Rust native fixtures,
web and desktop Svelte checks, and the release app build. The pending-folder
navigation regression was observed failing before its busy-state reset fix.

The first launch remains hidden for menu-bar use. A macOS reopen event with no
visible windows reveals and focuses the existing bundled library window; it does
not create a new webview or load remote HTML. Reopening while another app window
is visible leaves it alone.

## Platform checks

The manual **Desktop native build** workflow runs focused tray checks, native
fixture tests and native compilation on macOS, Windows and Linux. Native builds
and parser fixtures do not establish live OS dialog/download behavior. Windows
intentionally uses the server chooser; Linux native verification requires visible
service/process/listener ownership and otherwise falls back.

The 2026-10-21 platform run passed macOS and Linux checks/native compilation:
[platform run](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/39549285991).
Windows exposed two missing build inputs (compiled-test fixture paths and an ICO)
and a host-separator assumption in a macOS fixture. Both missing-file regressions
were observed locally before fixing them; the path-separator failure was observed
on the Windows runner. The fixes retain the existing icon pixels and production
service behavior. All-platform resource tests now prevent skipped Windows tests
from hiding missing fixtures/icons. The workflow accepts an optional OS choice
for focused retries rather than repeating successful platforms.

Final Windows retry passed tray checks, all native fixtures and release compilation:
[Windows native checks](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/39550711851).
