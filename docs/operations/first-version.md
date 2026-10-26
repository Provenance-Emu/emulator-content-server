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

## Known limits for the next pass

- No relay/NAT traversal, arbitrary browser emulator support, or signing/JIT execution. These are separate integrations rather than promises of this build.
- Browser downloads collect bytes in memory. Device upload queues retain files/retry state only until the page closes.
- Device token creation/revocation remains available through the API. Membership assignment can be changed in the UI; a complete membership listing/editor remains a follow-up.
- Cores and CHD decoders are not included. The pinned NES profile has prior real-core acceptance; other profiles need their own acceptance.
- Native Finder mounting, live VPN/proxy deployment and broader platform interoperability remain manual follow-ups.
- The Docker recipe now bundles the UI; a live container check could not run during this pass because the Docker daemon was unavailable. The isolated deployed CLI/UI regression exercises the shared bundle directly.
- Desktop browser teardown is fixed: browser keep-alive sockets survived page navigation, so the test now closes its browser context before API teardown and verifies completed download bytes. All nine focused desktop/access/player cases pass.
- [Desktop installers](desktop-install.md) are the next distribution artifact under the name Emulation Server. macOS Developer ID signing works; notarization, Intel builds, npm publication and hosted container images remain follow-ups.

## Desktop shipping pass

The native shell now installs a menu before the hidden status webview initializes, preventing an inert status icon when frontend startup fails. Startup errors also reveal the status window. App/window/web/default-server display names now use Emulation Server while bundle/service/auth identifiers stay compatible. macOS app compilation, Developer ID signing and simple DMG packaging passed. All 26 Rust fixtures, 23 tray controller tests, nine focused real-browser tests and 29 affected server/CLI regressions pass. Fastify, fast-uri and esbuild dependency updates bring the local dependency audit to zero reported vulnerabilities.

## Local validation

The completion pass uses the real API with generated temporary content. It covers account creation, password replacement, library permission assignment/removal, network policy, guest token sign-in/reload/revocation, reader-owned WebDAV credentials, revoked-owner clearing, and player token adoption. Packaging checks run a deployed CLI outside the checkout, fetch its UI and referenced assets, and verify a forced deployment cannot delete an existing destination. See the completion plan for the final check results.
