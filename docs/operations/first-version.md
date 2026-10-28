# First-version status — 2026-10-26

This is an early usable build for feedback. Run the portable Node.js server, open `/ui/`, create the owner, add a library, and register a folder or upload files. Existing folders are scanned in place. Use Settings to manage libraries, storage and access.

## Download and run

Install Node.js 22.22.2, extract the portable archive, and run this inside the extracted `server` folder:

```sh
node dist/src/main.js serve --data ../content-data
```

Open `http://127.0.0.1:8473/ui/` and paste the bootstrap token printed by the server to create your owner. All collection data stays in the separate `content-data` directory. Stop the server with Ctrl+C. Keep that directory when replacing the application with a newer build.

The default listens on this computer only. For other devices on the LAN, restart after setup with `--host 0.0.0.0 --advertise`. Account and guest access is managed in Settings → Access. Use `--webdav` to enable Finder/WebDAV access. Public access and optional emulator/decoder configuration are described in the repository's operations documentation.

| Feature | First-version support |
| --- | --- |
| Library browser | Search, filters, bounded pages, game/file details and downloads |
| Imports | Server folders or device files/folders, upload review, resumable transfer and retry |
| Saves | Battery saves, states, preserved conflict copies and explicit adoption |
| Matching | Metadata/artwork/patch/cheat review, provider failures and retry |
| Folder automation | Optional watching and organization with persistent policies |
| Sharing | Accounts, reader/editor assignment/removal, guest grants, token sign-in and revocation |
| Network policy | LAN, explicit subnets or credentials everywhere; public mode keeps authentication |
| WebDAV | Opt-in read-only browsing and downloads; per-account app credentials in the UI |
| Archives/discs | ZIP access; CHD requires a configured decoder and supported layout |
| Browser player | Configured pinned NES/FCEUmm profile; cores are not bundled |
| Desktop | Shared library UI in tray companion; existing native acceptance is documented separately |
| Plugins | Separate host for connectors, matching, feeds and execution plans |
| App integration | Generated TypeScript/Swift clients; emulator adapters belong to each app repository |
| Installation | Portable production directory with bundled web UI; Docker uses the same bundle |

## Approachable library pass

The current source adds a useful Home with library cards and a direct Create action. An empty library has an Add your first game path; Add games clearly separates uploading device files/folders from scanning files already on the server. Canceling does not create content. Reader help respects permissions. Search stays visible on phones, optional filters collapse, and management actions live under Library tools. Supported games have a prominent Play action; unsupported games explain downloading to an emulator. File downloads have readable phone rows and precise accessible names. Sign-in explains which account to use. An unavailable server offers a working retry instead of asking for a password.

The desktop connection form collapses while browsing. The new UI is included in all published 0.1.2-alpha.1 installers and the portable server. The Apple Silicon DMG is signed, Apple notarized and stapled. Windows and Linux packaging jobs completed and all five installer/archive digests match their published checksums. See [design and journey evidence](../superpowers/specs/2026-10-26-approachable-library.md).

Validation: 62 focused existing/updated browser cases passed, followed by 17 final focused onboarding, player/download, connection recovery and authorization cases. The design agent's 10 desktop/UX browser cases passed. Both Svelte checks report zero errors/warnings; web/tray controller suites, production builds, lint, package boundaries and the secret scan pass. A failed-startup regression reproduced the inert retry before its fix; reconnect coalesces requests and never resumes private discovery after sign-out. Screenshots use disposable generated fixtures, not operator games or user research participants.

## Storage and transfer update — 0.1.3

Storage now has tabs for existing server folders, uploaded copies and mounted remote storage. Existing unassigned folders are offered for explicit linking; linked folders scan automatically, never-scanned folders have a visible scan action, and reselecting an existing folder no longer ends at a duplicate-path error. Desktop controls and the web folder browser are more compact. The verified local desktop service uses the native OS folder dialog.

Direct disk downloads and opt-in upload recovery are included in 0.1.3. Recovery stores metadata only, requires reselecting and verifying the original files, and needs an explicit retry. See [upload recovery](upload-recovery.md) and [downloads](downloads.md).

## Known limits for the next pass

- No relay/NAT traversal, arbitrary browser emulator support, or signing/JIT execution. These are separate integrations rather than promises of this build.
- The source follow-up supports direct disk saving in browsers with a secure save picker, with a 256 MiB cap and guidance for buffered fallback downloads. See [downloads](downloads.md) for browser support and release scope. Opt-in upload recovery retains transfer metadata across reloads; file bytes must be reselected and verified.
- Settings → Devices lists your account's app tokens and supports read-only/read-write creation and revocation. Secrets are shown once, in memory. Settings → Access now shows the selected account's current library role and refreshes it after assignment/removal. These UI additions are included in the 0.1.1 update.
- Cores and CHD decoders are not included. The pinned NES profile has prior real-core acceptance; other profiles need their own acceptance.
- Native Finder mounting, live VPN/proxy deployment and broader platform interoperability remain manual follow-ups.
- The release Docker build and live health/UI/asset smoke check passed on ARM64 Linux through the existing Colima VM. The smoke check uses a random loopback port and a disposable container, so it does not collide with a running server. The VM was returned to its stopped state and the original Docker context restored.
- Desktop browser teardown is fixed: browser keep-alive sockets survived page navigation, so the test now closes its browser context before API teardown and verifies completed download bytes. All nine focused desktop/access/player cases pass.
- [Desktop installers](desktop-install.md) are published under the name Emulation Server: Apple Silicon DMG, Windows x64 MSI, Linux x64 DEB and AppImage. The Apple Silicon DMG is Developer ID signed, Apple notarized and stapled. Intel builds are deprioritized; registry publication remains a follow-up. npm publication requires registry authentication, which is not configured on this machine.
- The JavaScript dependency audit is clean. GitHub still reports the moderate upstream `glib::VariantStrIter` Rust advisory in the Linux GTK dependency stack (`glib` 0.18.5 through GTK 0.18.2); updating that stack remains deferred.

## Desktop shipping pass

The native shell now installs a menu before the hidden status webview initializes, preventing an inert status icon when frontend startup fails. Startup errors also reveal the status window. App/window/web/default-server display names now use Emulation Server while bundle/service/auth identifiers stay compatible. macOS app compilation, Developer ID signing and simple DMG packaging passed. All 26 Rust fixtures, 23 tray controller tests, nine focused real-browser tests and 29 affected server/CLI regressions pass. Fastify, fast-uri and esbuild dependency updates bring the local dependency audit to zero reported vulnerabilities.

## Local validation

The completion pass uses the real API with generated temporary content. It covers account creation, password replacement, library permission assignment/removal, network policy, guest token sign-in/reload/revocation, reader-owned WebDAV credentials, revoked-owner clearing, and player token adoption. Packaging checks run a deployed CLI outside the checkout, fetch its UI and referenced assets, and verify a forced deployment cannot delete an existing destination. See the completion plan for the final check results.
