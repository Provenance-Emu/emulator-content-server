# Service lifecycle

Run `ecs serve` as a background service that starts at login on macOS, Linux, and Windows. The CLI generates and removes the platform registration. It does not become a supervisor of its own.

## Owned paths

- `apps/cli` `service` command and log rotation
- tests and `docs/operations`

## Behavior

- `ecs service install|uninstall|status` manages a per-user registration. Never a system-wide or root service, because the data directory and `bootstrap.token` are user-owned at mode `0600`.
- macOS writes a LaunchAgent plist under `~/Library/LaunchAgents` with `RunAtLoad` and `KeepAlive`.
- Linux writes a systemd user unit under `~/.config/systemd/user`, enabled with `systemctl --user`. Document `loginctl enable-linger` for a server that must run while logged out.
- Windows registers a Task Scheduler logon task. No service wrapper binary and no elevation.
- The registration records the data directory and the listen flags. It never records a bootstrap token, a bearer token, or a password. Credentials stay in the data directory.
- Refuse to install when the recorded flags would fail `assertListenPolicy`, because a server that starts at login must not come up publicly exposed without TLS.
- A daemon has no terminal, so `serve` writes to a log file under the data directory and rotates it by size. Request logs keep the existing shape and still omit authorization headers.
- `install` is idempotent and leaves one registration. `uninstall` removes only what `install` wrote. `status` reports whether the registration is loaded, whether the process is running, and on which port.

## Acceptance

- The generated registration text is asserted for each platform from unit tests, without touching the real user session.
- Installing twice leaves exactly one registration, and uninstalling leaves none.
- No token, password, or authorization header appears in a generated registration or in a rotated log. A test asserts this.
- Installing with a public exposure and no TLS flag is refused.
- Log rotation keeps a bounded number of files and never deletes the live one.

## Status

`ecs service install|uninstall|status` writes a per-user LaunchAgent, systemd user unit, or logon task. `serve` logs to the data directory when it has no terminal. The tray does not start or stop the registration yet.

## Non-goals

Root daemons in `/Library/LaunchDaemons`, Windows service binaries, auto-update, crash reporting, and a process supervisor beyond what the platform provides.
