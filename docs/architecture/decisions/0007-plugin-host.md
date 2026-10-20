# ADR 0007: Plugins live in a second process

The content server is the sync and REST API. NAS and cloud accounts, a wasm player, AltStore-style sources, and JIT or signing are other products that share a checkout so a developer can ship one, and they do not share a process.

A connector, a player, a feed, a signer, and a JIT activator are plugins. `ecs-plugins` loads them. `ecs serve` does not. The host calls `/api/v1` with a bearer token the operator keeps in `ECS_TOKEN`. It does not import the catalog or the blob store, and `/api/v1/capabilities` does not grow a flag for any of it.

File protocols (NFS, SMB, AFP, and iCloud Drive) are read through a folder the operating system has already mounted. HTTP APIs (S3, including an S3-compatible NAS, Google Drive, Dropbox, and Box) are called by the host. A plugin may replace either with its own entry module. The sync planner only sees paths, sizes, and digests, so a new backend does not change the content API.

Each feed, signer, JIT activator, and player names the bundle ids it serves. A plugin cannot publish or sign a bundle it did not claim, which is how another developer adds a source for their app without editing Provenance's. Signing plans `zsign` and does not run it. The certificate password is not a parameter, because the command line would show it. JIT plans `pymobiledevice3` and does not attach anything. The player descriptor records a `.wasm` path and does not compile it, so a module cannot run next to connector credentials.

The separate browser-static distribution exception is recorded in [ADR 0008](0008-browser-static-player.md). It does not load plugin manifests or publish plugin directories.

## Consequences

- Cloud tokens and Apple material stay in the plugin directory, mode `0600`, never in `plugin.json` and never in the content database.
- The content server keeps working with the plugin host absent.
- Extracting the host into its own repository later needs no schema change.
- An operator who points the plugin directory at untrusted code is running that code as themselves. The content server still does not load it.
