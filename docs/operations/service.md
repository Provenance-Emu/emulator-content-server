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
| macOS | `~/Library/LaunchAgents/app.emulator-content-server.plist`, then `launchctl bootstrap`. `RunAtLoad` and `KeepAlive` are set. |
| Linux | `~/.config/systemd/user/ecs.service`, then `systemctl --user enable --now`. For a server that must run while logged out, run `loginctl enable-linger` once as that user. |
| Windows | A Task Scheduler logon task named `EmulatorContentServer`, at the user's own privilege. There is no service binary and no elevation. |

`install` again overwrites that one registration. `uninstall` removes it and leaves every other agent, unit, or task alone.

A daemon has no terminal. `serve` then writes `logs/ecs.log` under the data directory, redacts authorization headers and token or password values, and rotates the file by size. The live file is renamed aside when it grows; only an older archived generation is deleted. `logs/ecs.pid` is how `status` tells a running process from a loaded registration that is stopped. `status` prints whether the registration is loaded, whether that process is running, and which port it was given.

Optional native CHD support is selected with `--chdman <absolute-path>` or
`ECS_CHDMAN_PATH`. Service installation persists the selected path as an explicit
argument. See [CHD configuration, supported layouts and limits](chd.md).
