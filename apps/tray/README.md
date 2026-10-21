# Local login service controls

The menu and status window can start and stop the login service registered for
this user on this computer. The address in **Server** controls HTTP monitoring;
it does not select the service these buttons manage. A manually started server
is not managed by these controls.

Install the registration first through the CLI, using your existing library:

```sh
ecs service install --data /absolute/path/to/library --port 7878
```

Start and Stop preserve the registration and its listen settings. Stop unloads
the macOS LaunchAgent (so KeepAlive cannot restart it), stops the Linux user unit
without disabling it, or stops the current user's Windows logon task. It remains
configured to start at the next login. Quitting the tray leaves the service alone.

The native bridge accepts no server address, data directory, executable, task
name, or credentials. It only controls the fixed registration the CLI installs.
The tray does not read the library or its PID file. Windows also checks the task's
principal belongs to the current user and uses interactive, least-privilege login.

Run `pnpm verify` for the frontend tests and checks. The Windows job exercises the
actual PowerShell script with fake Task Scheduler objects, without touching a
real task. Run `cargo test --manifest-path apps/tray/src-tauri/Cargo.toml` for the
native command tests, and `pnpm tray` to build a native bundle on the current OS.


## Verified local folder dialogs

In the bundled library window, **Use local managed service** derives its address
from the current user's fixed OS service registration and process/listener metadata.
**Connect** always selects a manual server profile, including loopback addresses,
and uses that server's folder chooser. Discovery and server claims never enable
a native dialog. Restored profiles require another explicit local verification.

macOS correlates the fixed LaunchAgent, numeric process owner and microsecond
birth time from OS metadata, and a single exact loopback listener from bounded
`lsof` output. Linux correlates the fixed user unit's MainPID, invocation and start
generation, bounded `/proc/PID/stat` identity metadata and visible `ss` ownership.
Missing tools, permission failures, wildcard or multiple listeners, malformed or
oversized output fail closed. Windows currently uses the server chooser because
a running Scheduled Task does not prove ownership of the server listener.

The native bridge takes only an opaque verification ID and a fixed folder purpose.
It rechecks identity before and after the directory-only dialog; the shared
controllers revalidate immediately before API registration. Cancellation writes
nothing and never opens a second chooser. Switching server discards an open dialog's
result. Expired or changed identity shows a recovery action: verify the managed
service again, or **Connect** to use the server chooser. When explicit re-verification
becomes unavailable, the app switches to a fresh server-chooser context at the same
address, resetting navigation and discarding staged native selections. IDs expire after 30 minutes
and at most 16 are retained. New library folders stage until **Create library**;
existing-library confirmation registers and scans once. Upload destinations keep
the current upload target until explicitly selected.

Only the fixed bundled `library.html` in the `library` window has folder IPC.
Native handlers independently check both document and window. Remote navigation
and new windows are blocked. No generic filesystem, process or dialog permission
is granted to JavaScript; the dialog plugin is used only from Rust.

Local acceptance: macOS Rust fixtures, desktop adapter/controller tests and
Chromium composition/fallback checks run with generated temporary data. The
operator's fixed LaunchAgent was absent (launchctl exit 113), so an actual native
dialog was not exercised. Linux/Windows interactive and native build acceptance
remain for the manual platform workflow; fixtures alone do not establish those passes.

Reopening the macOS app from Finder or the Dock reveals its existing bundled
library window when both windows are hidden. See [Desktop acceptance](../../docs/operations/desktop-acceptance.md)
for actual platform evidence and remaining interactive checks.
