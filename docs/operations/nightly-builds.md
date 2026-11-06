# Nightly installation and testing

Download from the stable [nightly release](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/nightly). CI refreshes the server packages and desktop installers after the nightly matrix passes. The release notes link the exact source commit and build run. A failed matrix leaves the previous nightly in place. Back up your data before upgrading. Restoring that backup is required to downgrade a database.

## Choose a download

| System | Server archive (includes Node and web UI) | Optional desktop companion |
| --- | --- | --- |
| Linux x64 | `Emulation-Server-nightly-linux-x64.tar.gz` | `Emulation-Server-nightly-linux-x64.deb` or `.AppImage` |
| Windows x64 | `Emulation-Server-nightly-windows-x64.zip` | `Emulation-Server-nightly-windows-x64.msi` |
| macOS Apple Silicon | `Emulation-Server-nightly-macos-arm64.tar.gz` | `Emulation-Server-nightly-macos-arm64.dmg` |

No source checkout, pnpm, Rust or separate Node installation is needed for the server archive. Intel macOS, ARM Linux/Windows and other distributions are not verified by this matrix. Linux packages are built on Ubuntu 24.04. Server builds contain no emulator cores, ROMs, BIOS files or personal libraries; optional cores are installed separately.

Download `SHA256SUMS.txt` from the same release and verify the file before extraction. Linux: `sha256sum --ignore-missing --check SHA256SUMS.txt`. macOS: `shasum -a 256 --check --ignore-missing SHA256SUMS.txt`. On Windows, use `Get-FileHash .\Emulation-Server-nightly-windows-x64.zip -Algorithm SHA256` and compare the full digest to its line in `SHA256SUMS.txt`. Files are replaced in place, so if verification fails during a refresh, download both again. Checksums verify download integrity; they are not code signatures.

## Start the server

On macOS/Linux, extract your platform archive in Terminal (replace the filename for your system):

```sh
tar -xzf Emulation-Server-nightly-macos-arm64.tar.gz
cd Emulation-Server-nightly-macos-arm64
./ecs serve --data "$HOME/EmulationServerData" --host 127.0.0.1
```

On Windows, open PowerShell in your Downloads directory:

```powershell
Expand-Archive .\Emulation-Server-nightly-windows-x64.zip -DestinationPath .
cd .\Emulation-Server-nightly-windows-x64
.\ecs.cmd serve --data "$env:LOCALAPPDATA\EmulationServerData" --host 127.0.0.1
```

Open <http://127.0.0.1:8473/ui/>. The first run prints a one-time setup token; enter it privately in setup to create the owner account. Add a collection and scan a folder you own, or upload a small file. Keep the data directory outside the extracted application so upgrades preserve your collection. Stop with Ctrl+C. For LAN access, services, backup and remote TLS configuration, follow the [installation guide](install.md) and [service guide](service.md). The portable launcher runs all CLI commands; use `./ecs --help` or `.\ecs.cmd --help`.

## Optional desktop companion

The desktop app connects to a separately running content server; it does not include or silently start that server. Windows: run the MSI. Linux: install the DEB with your package manager, or `chmod +x` the AppImage and run it on a tray-capable desktop. macOS: open the DMG and drag Emulation Server to Applications. Connect it to `http://127.0.0.1:8473` or your configured server address.

Linux and Windows nightly desktop installers are unsigned. When macOS signing is enabled, the macOS tray installer is Developer ID signed and Apple notarized from the same commit as the server archives. Its release asset label identifies its source commit. Repositories with signing disabled retain their last notarized DMG and can download the unsigned tray build as a workflow test artifact.

## What CI proves and what to test

Every server archive is extracted into a clean temporary directory on its native OS/architecture, then tested using its bundled Node runtime: launcher help, SQLite initialization, `/health`, `/ui/`, referenced JavaScript/CSS assets and `doctor`. Desktop jobs run interface checks, generated native service/process tests, and package the installers. CI verifies every archive/installer checksum before publishing the complete set.

Interactive desktop installation, real hardware, emulator playback and app-to-server integration still need tester coverage. Start with a temporary data directory and a small lawful test file. Check setup, folder scanning/upload, browser library access, restart/persistence, and connection from your app. Record the `BUILD.json` commit (or release source commit for desktop), platform, steps and expected/actual behavior in a GitHub issue. Never post tokens, credentials, private game files or your database.

## Upgrades and maintainer operation

In a portable package that includes the updater, sign in as the server owner
and open **Settings → Updates**. Choose **Release** for tagged server builds
(including tagged alphas during pre-release) or **Nightly** for the moving
nightly build. **Off** disables checks. **Manual** checks hourly and offers
**Update now**, **Later** (24 hours), or **Skip this version**. **Automatic**
checks hourly and installs eligible builds even when the web UI is closed.
The server keeps serving during download and restarts to activate the verified
archive. If the new build fails to start, the launcher restores the previous
build and its pre-update catalog.

For unattended operation, keep the extracted launcher in a permanent
location and install the per-user service using the same data path and listen
options as the current installation. On macOS or Linux:

```sh
./ecs service install --data "$HOME/EmulationServerData" --host 127.0.0.1
```

On Windows, run `ecs.cmd service install` with the corresponding Windows data
path and listen options. Select **Nightly → Automatic** in the web UI once the
service starts. The launcher retains update preferences and managed builds
in the server's data directory. Source checkouts, externally managed
deployments and desktop companions use their existing installation methods.

For a one-time migration from an older installation, back up the data directory,
extract an updater-enabled package into a fresh directory and install its
service using the existing data path and flags. For a foreground installation,
stop the old server first and start the new package with `ecs serve`. Keep the
old build and matching data backup until testing passes.

The [Nightly distributions workflow](https://github.com/Provenance-Emu/emulator-content-server/actions/workflows/nightly.yml) builds only committed source and production dependencies. Pull requests retain the regular Linux verification. The full distribution matrix runs only on the nightly schedule or manual dispatch. Publication requires the main-branch builds and any enabled signing job to succeed. Release assets retain stable names and include per-platform and combined SHA-256 manifests. A manual run on a branch provides Actions artifacts only.

### Enable macOS signing in GitHub Actions

Create the `nightly-macos-signing` environment and restrict its deployment branches to `main`. Store a dedicated CI Developer ID Application identity and a notarization-capable App Store Connect team key as environment secrets.

| Environment secret | Value |
| --- | --- |
| `ECS_MACOS_SIGNING_P12` | Base64-encoded, password-protected PKCS#12 with a single Developer ID Application identity |
| `ECS_MACOS_SIGNING_PASSWORD` | PKCS#12 export password |
| `ECS_MACOS_NOTARY_KEY` | App Store Connect private key in PEM format |
| `ECS_MACOS_NOTARY_KEY_ID` | App Store Connect key ID |
| `ECS_MACOS_NOTARY_ISSUER_ID` | App Store Connect team issuer ID |

Set the repository Actions variable `ECS_NIGHTLY_MACOS_SIGNING` to `true` after adding all five secrets. The signing job uses the macOS installer built by the same workflow run. It imports the identity into a temporary keychain, signs the app and disk image, submits the DMG to Apple, staples the ticket, and checks both the mounted app and disk image with Gatekeeper before generating checksums. A signing or notarization failure leaves the previous nightly available.

To attach update-enabled archives to a tagged server release, run the same
workflow on the tag after creating the GitHub release. Use a tag that includes
the updater and workflow changes:

```sh
gh workflow run nightly.yml --ref v0.2.0 -f release_tag=v0.2.0
```

The workflow adds platform archives and updater manifests to the tagged
release after native package smoke tests. Each manifest identifies a build
and the expected SHA-256 of its archive. The updater selects compatible
server assets from the project repository, so catalog, core and desktop-only
releases do not enter the server update feed.
