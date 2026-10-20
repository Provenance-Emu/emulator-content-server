# Plugins

`ecs serve` is the library. `ecs-plugins` is everything that is not the library: a folder on a NAS or a cloud account, an AltStore source, a wasm player, a signer, or a JIT activator. The host is a separate process. It does not open the content database, and the content server does not load plugins.

```sh
pnpm build
node apps/plugins/dist/src/main.js list --plugins examples/plugins
node apps/plugins/dist/src/main.js feed --plugins examples/plugins --out ./feeds
```

`ECS_TOKEN` is the bearer token. `ECS_SERVER` defaults to `http://127.0.0.1:8473`. `--token` is refused, because a command-line argument is visible to other users on the machine.

## What a plugin is

A plugin is a directory with `plugin.json`. `engine` is `ecs.plugin/1`. `kind` is `connector`, `feed`, `player`, `signer`, or `jit`. Feed, player, signer, and JIT plugins list `apps`, the bundle ids they are allowed to touch. A free-account suffix of one of those ids still counts. A different bundle does not.

Copy a directory from `examples/plugins` and change the ids. Drop the directory into the folder you pass to `--plugins`. One broken plugin is reported and the others still load.

## Connectors

A connector is how bytes get to the library. The host lists the folder, hashes what the listing did not, and uploads through the existing resumable upload. Same bytes are skipped, including a save that the server already kept under a conflict name. A differing ROM is refused. A differing save is uploaded with a stale revision so the live save stays where it is and the arrival is kept beside it.

```sh
ECS_TOKEN=... node apps/plugins/dist/src/main.js sync \
  --plugins ./plugins --id home.library.smb --library <libraryId> --item <itemId>
```

| Scheme | How it connects |
| --- | --- |
| `local`, `nfs`, `smb`, `afp`, `icloud` | `connector.root` is the mounted folder. The host does not speak NFS, SMB, AFP, or iCloud Drive. Mount the share first. iCloud has no public API here. |
| `s3` | `bucket`, `region`, and optional `prefix`. `endpoint` points at an S3-compatible NAS. Credentials go in `secrets.json`. |
| `googledrive`, `box` | `folderId`. The host lists that folder and its children. |
| `dropbox` | `prefix` is a folder path such as `/library`, so a plugin cannot import the whole account. |
| `custom` | `entry` is a `.js` or `.mjs` module that exports `createConnector`. |

`secrets.json` sits next to `plugin.json` at mode `0600`. The fields are `accessKeyId` and `secretAccessKey` for S3, and `accessToken` for the others. A secret in `plugin.json` is refused. A file other users can read is refused. `doctor` names the missing field and never its value.

Kind rules map a suffix to an asset kind. Unmatched files are ROMs, which keep strict concurrency. `.sav` as `battery_save` is the usual save rule.

Mounts sync in both directions. HTTP connectors push into the library. They do not write back.

## Feeds

A feed plugin renders one AltStore source. Legacy `version`, `versionDate`, `downloadURL`, and `size` mirror the newest entry in `versions`, so an older client and a current one both see a build. Each plugin is its own source. Another developer publishes their apps by adding a plugin, not by editing yours.

`ecs-plugins feed --out ./feeds` writes one JSON file per feed. The examples use `https://example.invalid` and bundle ids `org.provenance-emu.provenance`, `org.provenance-emu.icube`, and `org.provenance-emu.ifly`. Replace the ids, the icon, and the IPA URL before you publish. Download URLs are https and do not carry credentials.

`ecs-plugins serve` publishes those feeds on `127.0.0.1` and rewrites each `sourceURL` to the URL that was requested, which is what a client refreshes. The index is `/`. A request can only name a plugin id, so the process will not hand out `secrets.json`, a certificate, or a wasm module. `--allow-lan` binds every interface. The content server is not involved.

A feed cannot list a bundle id that `apps` did not claim.

## Player

A player plugin names dotted system identifiers and a `.wasm` file inside the plugin directory. `doctor` reports whether the file is there. The host does not compile it, and `ecs serve` does not mount it. The pages at `/ui` and `/play` stay clients of the content API. Separately, optional [browser playback](browser-playback.md) serves one validated trusted browser-static loader/WASM pair from a dedicated `--player-dir`; that directory is independent of plugin directories and never contains `plugin.json` or `secrets.json`. This does not mount player plugins.

## Signer and JIT

A signer plans `zsign` for a bundle it claims. A JIT plugin plans `pymobiledevice3` for a bundle it claims. Neither plan is executed. The signer does not take a certificate password, because `zsign -p` would put it in the process list. Put `identity.p12` and the `.mobileprovision` in the plugin directory at mode `0600`. The content server never reads them.

`ecs-plugins sign-plan --id <plugin> --ipa <file> --profile <file> --device <udid>` reads the IPA and the profile and prints the `zsign` arguments, then `not run`. `--password` and `-p` are refused. The certificate named by the plugin is not opened.

`ecs-plugins jit-plan --id <plugin> --bundle <bundle id>` prints the commands and then `not run`.
