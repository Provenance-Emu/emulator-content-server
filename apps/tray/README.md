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
