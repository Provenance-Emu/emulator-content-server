# Emulation Server desktop

Download the installer for your platform from the GitHub release. The desktop app connects to the content server over its API; install/run the portable server separately, or connect to an existing server. The app does not move or open your server's catalog.

## macOS

Open the DMG and drag **Emulation Server.app** onto **Applications**. Open it from Applications; its icon appears in the menu bar. Click it for **Open library**, **Server status and settings**, or **Quit**. The full status menu loads when the status interface initializes. The native menu remains available if the interface cannot initialize or the server is offline. Reopening the app from Finder/Dock reveals the library when no windows are visible.

The macOS installer targets Apple Silicon and is Developer ID signed and Apple notarized. The current DMG carries a stapled notarization ticket, so Gatekeeper can validate it offline. Intel/universal builds are not a current priority. The bundle identifier, service registration, profiles and stored sessions retain their existing identifiers through the rename from Content Server Status.

The 0.1.1 update includes Settings → Devices for revocable app tokens and shows current library access in Settings → Access. Its higher application version supports upgrading the first 0.1.0 installer.

Choose your server address in the library window, such as `http://127.0.0.1:8473`, and select **Connect**. **Use local managed service** requires a service previously installed with `ecs service install`; it does not install or start a new server implicitly. The menu's service controls act only on that fixed local registration.

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
