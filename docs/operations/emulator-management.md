# Install and manage browser emulators

Open **Settings → Emulators**. Sign in as the server owner if requested; network admission alone does not grant software installation permission.

**Available** lists the trusted catalog. Install downloads one pinned package, verifies its whole-package and individual resource hashes, and activates it without a server restart. An unavailable entry explains the limitation; it does not enable Play. The catalog currently includes the verified NES/FCEUmm and BIOS-free Jaguar builds. Other providers can supply a `.ecsplayer` package: choose **Install from file** with the normal OS file picker, then explicitly install it. Only install packages from a source you trust.

**Installed** shows supported systems, formats, build and system files. Enable or disable an emulator, choose the default, or remove a managed installation. Changes apply to new launches. Already running sessions retain their loaded bytes. Removing an emulator does not remove games, saves, source folders or original package files. Operator-configured directories remain read-only; their profiles can be disabled or selected as default.

Managed resources live under the existing server data directory's `players` folder. No `--player-plugins` configuration is needed for UI installs. Explicit external player directories remain supported. Preferences are persisted atomically in `player-settings.json`. A bounded package is completely validated in staging before publication; failures leave the prior active registry intact. Installs and changes are serialized, with at most 16 profiles and 256 MiB of resource snapshots.

## Systems and limits

- **NES/FCEUmm:** real rendering, keyboard input, audio buffers, battery-save and state restoration passed through the isolated launcher. See [acceptance](browser-playback-plugin-acceptance.md).
- **Jaguar:** BIOS-free HLE/direct cartridge and ABS support. Both an original ABS program and a standard-layout original1 MiB cartridge ran, advanced their emulated 68K counter and rendered the expected green display. JaguarCD, GPU-only boot intros and synchronized saves are unsupported. Real commercial-title compatibility and Jaguar audio/input behavior are not established by those programs.
- **Dreamcast/Naomi/Naomi2/Atomiswave:** the maintained parallel-dc browser port is under acceptance. Read the Available entry for current installation readiness; compilation alone does not establish playable compatibility. Self-contained arcade archives and single-file media are the intended initial scope. Split-parent sets, linked cabinets and GD-ROM companions require additional adapters.

Plugin profiles may declare up to512 MiB of game data; individual builds can use a smaller limit. Large games require enough browser memory for complete staging and core execution. Loader8 MiB, WASM64 MiB, declared assets32 MiB combined, and selected/captured saves64 MiB remain independent limits. Grouped/multi-file disc layouts are not advertised as playable. Original bytes are not converted, renamed on disk or moved.

## Atomiswave system file

For the managed parallel-dc emulator, **Add system file** accepts the operator's own `awbios.zip`. It must contain root member `bios0.ic23` (131072 bytes). The core's expected CRC32 is `719b2b0b`; the server validates the archive's directory shape and size, while actual firmware compatibility remains the core's check. Firmware is never downloaded or included in the emulator package.

The native file picker selects a local file. No upload happens until **Install system file** is chosen. Uploading the same name replaces the installed copy atomically. Games and saves stay unchanged. Declared system files are shared with admitted players on the server; do not put unrelated private files in the archive. The launcher stages this known file at `/ecs/system/dc/awbios.zip`. Atomiswave is withheld from the readable playback catalog until the resource is present. Dreamcast/Naomi/Naomi2 HLE requirements depend on the accepted core build.

## Package and integration details

A `.ecsplayer` file contains a 4-byte big-endian UTF-8 header length, a JSON object `{manifest, files:[{name,size}]}`, and exact raw file bytes in loader/WASM/assets order. The header is capped at 64 KiB and the package at 104 MiB plus header. It is not an archive: names must exactly match the data-only manifest's flat portable filenames; extra, duplicate, altered, truncated and trailing data are rejected. The package cannot contain an executable plugin entry. No code runs in the HTTP server.

The owner-only management router owns its buffering parsers and limits; unrelated public authentication routes do not recognize them. Management clients reject redirects. Trusted network downloads use only the pinned catalog's HTTPS GitHub/CDN destinations, exact sizes/hashes and a deadline. No caller-supplied download URL or incoming credential is forwarded. Browser execution retains the opaque-origin sandbox and private bounded channel described in [player plugins](web-emulation-plugins.md).

Use `scripts/browser-core/package-player.mjs` to package an externally installed, validated plugin. The optional [core release](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/v0.1.4-cores.1) supplies separate binaries, corresponding source/build recipes and notices. No ROM, save or copyrighted boot-ROM image is included in these core packages.
