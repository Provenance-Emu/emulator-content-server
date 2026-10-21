# Desktop acceptance

Use generated content and a temporary loopback server/catalog for interactive
checks. Never point an acceptance upload or folder-registration check at an
operator catalog. Build the bundled app with `pnpm --filter @ecs/tray tauri build
--bundles app`; `pnpm --filter @ecs/tray check` and the Rust fixture tests cover
controllers and fixed native boundaries separately.

## macOS checks — 2026-10-21

The release app was exercised through native accessibility automation, using two
isolated loopback servers with generated eight-byte content and an empty folder.

| Check | Result |
| --- | --- |
| Start hidden, then reopen from Finder/Dock | Found missing reopen handler; fixed and verified the bundled library window opens |
| Close library and reopen app | Passed; same library/selection remains available |
| Browse library and open generated game details in WKWebView | Passed |
| Switch between servers | Passed; A's collection/details disappear and B's libraries render |
| Local managed-service verification without a registered LaunchAgent | Passed; sanitized unavailable message, server chooser retained |
| Add server folder through the real webview fallback | Passed; one generated folder registered, summary reports completed scan and zero files |
| Open in browser | Passed URL handoff to Safari at selected server's `/ui/`; this fixture did not mount browser assets, so browser-page rendering is covered by the separate browser tests |
| Native download destination and completed bytes | Not verified; accessibility exposed the action as a table cell and coordinate input was unavailable. Chromium download coverage is not a WKWebView download pass |
| Real verified-local directory dialog selection/cancellation | Not verified; no managed LaunchAgent was installed. No operator service was installed or changed for acceptance |

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
