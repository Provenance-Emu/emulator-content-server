# Emulation Server desktop

Download the **Desktop app** installer for your platform from the GitHub release. The app remembers your servers and opens their libraries over the API. Choose **Standalone server** if you prefer a command-line installation.

## macOS

Open the DMG and drag **Emulation Server.app** onto **Applications**. Open it from Applications; its icon appears in the menu bar. Click it for **Open library**, **Server status and settings**, or **Quit**. The full status menu loads when the status interface initializes. The native menu remains available if the interface cannot initialize or the server is offline. Reopening the app from Finder/Dock reveals the library when no windows are visible.

The macOS installer targets Apple Silicon and is Developer ID signed and Apple notarized. The current DMG carries a stapled notarization ticket, so Gatekeeper can validate it offline. Intel/universal builds are not a current priority. The bundle identifier, service registration, profiles and stored sessions retain their existing identifiers through the rename from Content Server Status.

The 0.1.2 update includes the new Home, guided Add games, mobile filters and prominent Play controls. It also includes Settings → Devices for revocable app tokens and shows current library access in Settings → Access. Its higher application version supports upgrading the previous installers.

On first open, the app checks for a verified local service. Choose **Set up this Mac** to download the nightly server, install its login service, and open the owner form with the setup code filled in. If you reopened the app before creating the owner account, choose **Find setup code in Finder** on the owner form. Open the selected `bootstrap.token` file and paste its contents into the form. For a default installation, the file is under `~/Library/Application Support/Emulation Server/data`.

To use a server on another computer, enter its URL and select **Connect**. Use **Status and settings → Servers** to switch between saved servers. The local service controls apply to this Mac.

Choose **Install CLI Tools** from the menu bar to use `ecs` and `ecs-plugins`
in Terminal. It installs per-user commands in `~/.local/bin` and adds that
folder to the standard zsh or Bash profile when it can. Open a new Terminal
window to use the commands. See the [workflow host guide](ai-cleanup.md#run-the-native-host)
for `ecs-plugins workflows install-defaults`.

## Windows

Run the `.msi` installer, then open Emulation Server. Select your server address and connect. This early installer is unsigned. Service installation remains a separate CLI step. Folder selection uses the server's chooser.

## Linux

Install the `.deb` with your distribution's package manager, or make the `.AppImage` executable and run it. A tray-capable desktop is needed for the menu-bar companion. Connect to an existing server from the library window. Installers are built on Ubuntu 24.04; other distributions remain unverified.

## Building and publishing

The manual Desktop native build workflow accepts an existing `release_tag`. With a tag it builds and uploads native installers and platform-specific SHA-256 files. With an empty tag it retains the previous verification behavior. Installer jobs build only what produces the packages; routine CI remains separate.

For a local macOS release, build with `pnpm --filter @ecs/tray tauri build --ci --bundles app`, then run `node scripts/package-macos.mjs`. Set `APPLE_SIGNING_IDENTITY` when a signing identity is available. The DMG helper creates a simple app-and-Applications image through hdiutil, without Finder/AppleScript automation. Publish with `node scripts/publish-desktop.mjs <release-tag>`; an optional third argument selects a specific bundle directory.

## macOS notarization

After signing and packaging, submit the final DMG with an App Store Connect API key. Keep the private key outside the checkout and provide `ASC_KEY_PATH`, `ASC_KEY_ID`, and `ASC_ISSUER_ID` in the environment:

```sh
xcrun notarytool submit "$DMG_PATH" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
```

Only publish after Apple reports Accepted. Regenerate the SHA-256 file after stapling; stapling changes the archive bytes. The 0.1.1-alpha.1 Apple Silicon image was accepted on 2026-10-26, stapled, validated, and the installed app passed Gatekeeper as Notarized Developer ID.

The 0.1.2-alpha.1 installer refresh is published for Apple Silicon macOS, Windows x64 and Linux x64. The Apple Silicon image passed notarization, stapling and Gatekeeper; Windows/Linux native packaging completed successfully. All published installer/archive digests match their SHA-256 files.

The 0.1.3 update adds Storage tabs, explicit linking/scanning of existing folders, clearer scan retries and a compact server-directory browser. Alpha2 automatically re-verifies a saved managed-service profile when reopening the library window, preserving the native OS folder dialog. Manually entered local or remote server addresses continue to use server-directory browsing. Verification checks the actual fixed local service; a late response cannot override a different server selection.
