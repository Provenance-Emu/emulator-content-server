# Service

`ecs serve` can start at login as a per-user agent. It is not a root service, and the registration does not contain a bootstrap token, a bearer token, or a password. Those stay in the data directory.

```sh
ecs service install --data ./content-data
ecs service status --data ./content-data
ecs service uninstall --data ./content-data
```

The same listen flags as `ecs serve` are recorded: `--host`, `--port`, `--advertise`, `--allow-lan`, `--public`, `--tls-terminated`, and the optional trusted browser-static `--player-dir` ([setup](browser-playback.md)). Installing with `--public` and no `--tls-terminated` is refused, so a server that starts at login cannot come up publicly exposed without TLS.

| Platform | What install writes |
| --- | --- |
| macOS | `ecs service install` writes a login agent in `~/Library/LaunchAgents`. The [macOS installer](nightly-builds.md#install-with-one-command) also offers a system LaunchDaemon for boot startup. |
| Linux | `~/.config/systemd/user/ecs.service`, then `systemctl --user enable --now`. For a server that must run while logged out, run `loginctl enable-linger` once as that user. |
| Windows | A Task Scheduler logon task named `EmulatorContentServer`, at the user's own privilege. There is no service binary and no elevation. |

`install` again overwrites that one registration. `uninstall` removes it and leaves every other agent, unit, or task alone.

## Controlling it from the menu bar

The desktop app's menu and its **Status and settings** window control the service registered on this computer. They never need a server sign-in, because they talk to the operating system's service manager and not to the server.

| The window says | What it means | What you can do |
| --- | --- | --- |
| Local service running | Loaded and running | **Restart**, **Stop** |
| Local service stopped | Registered, not loaded | **Start** |
| Local service starting… | Loaded, waiting for its process | **Restart**, **Stop** |
| Local service keeps stopping | Loaded, and the last run exited with an error | **Restart**, **Stop**, **Repair** |
| Local service needs repair | The registration names a server build that is no longer on disk | **Repair**, **Stop** |
| Boot service running or stopped | Installed for the whole computer | **Start**, **Restart**, **Stop**, each after the macOS administrator prompt |
| Local service unavailable | The service manager could not be read | **Repair**, **Refresh** |

**Restart** replaces the running process (`launchctl kickstart -k`). **Stop** unloads the registration so it stays stopped until **Start** or the next login. **Start** on a registration someone disabled enables it first.

**Repair** (macOS) registers the login service again. It keeps the data folder and listen options already in the registration and runs `service install` from a build that is on disk: the registration's own build if it is still there, otherwise the build the CLI tools use, otherwise the newest one local setup installed. With no build left it downloads and verifies the nightly first. The server restarts; the library, saves and settings are not touched. It is always under **Something not working?** in the status window, and the menu bar's **Repair local service…** works even when the interface cannot load.

A failed action says which `launchctl` step failed and its exit code, and the controls stay on the state the service is really in. The boot service is repaired by running the installer again.

The macOS boot service uses `/Library/LaunchDaemons/app.emulator-content-server.plist` and runs as the installing user. Check it with `launchctl print system/app.emulator-content-server`. Administrator authorization is required to manage that system job; the desktop app asks for it with the standard macOS prompt when you start, stop or restart it. Server updates replace the worker behind the same launcher. At the next boot, the launcher starts the last successfully installed build after the startup disk unlocks.

A daemon has no terminal. `serve` then writes `logs/ecs.log` under the data directory, redacts authorization headers and token or password values, and rotates the file by size. The live file is renamed aside when it grows; only an older archived generation is deleted. `logs/ecs.pid` is how `status` tells a running process from a loaded registration that is stopped. `status` prints whether the registration is loaded, whether that process is running, and which port it was given.

Optional native CHD support is selected with `--chdman <absolute-path>` or
`ECS_CHDMAN_PATH`. Service installation persists the selected path as an explicit
argument. See [CHD configuration, supported layouts and limits](chd.md).
