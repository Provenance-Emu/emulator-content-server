# Desktop acceptance

Use generated content and a temporary loopback server/catalog for interactive
checks. Never point an acceptance upload or folder-registration check at an
operator catalog. Build the bundled app with `pnpm --filter @ecs/tray tauri build
--bundles app`; `pnpm --filter @ecs/tray check` and the Rust fixture tests cover
controllers and fixed native boundaries separately.

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
