# First usable version completion

The user wants a usable early release, with existing features accessible and fast iteration afterward. Keep the existing Svelte/API architecture and package boundaries; work in one batch on main. No new emulator adapters, relay, or signing execution in this server.

## Design

Expose existing account creation, password changes, library access assignment/removal and network policy in web Settings → Access. Separate account creation from membership assignment so a failed second request cannot duplicate an account. Hide secrets after submission and clear private results on authentication rejection or component disposal. Retain the existing guest-grant UI. Add explicit token sign-in, validating through an isolated client before adopting credentials; do not put credentials in URLs. Limit locally remembered pasted tokens to one day; server revocation/expiration always wins.

Expose existing WebDAV app credentials in settings for signed-in accounts when WebDAV is enabled. Show passwords once, keep them in memory, and support revocation. Passwordless trusted connections need an explicit account login for this feature.

Build and include the interface in a portable server deployment. Make Docker use that deployment, and verify the deployed CLI serves its bundled interface outside the workspace. Update the documented first-run path to open the UI and describe optional capabilities honestly.

## Implementation and verification

- [x] Add failing real-server browser tests for account/access management, token login/revocation, and WebDAV credential lifecycle.
- [x] Implement the missing settings and login flows using only `@ecs/client`.
- [x] Verify rejection, navigation/disposal and reader isolation; run focused browser acceptance and Svelte checks.
- [x] Add a portable deployment command, bundle UI, and verify the isolated deployed CLI and assets with generated temporary data.
- [x] Update install/status documentation with actual evidence and remaining integration limits.
- [x] Run affected checks and one proportionate review of authentication and distribution changes.

## Evidence

- Baseline `pnpm test`: 572 passed, five optional skips.
- `pnpm ui-check`: zero Svelte errors/warnings; 197 web controller tests and 23 tray tests passed, one Windows-only skip.
- Real-server browser acceptance: all seven new access cases passed, plus player username/password and 14 library cases. One pre-existing desktop-library case timed out during fixture teardown after completing its assertions; deferred under the user's fast-pass instruction.
- All four original access tests failed before implementation. WebDAV credential UI and player token adoption each failed before their fixes. Bundle UI served 404 before packaged asset discovery/copy was added. Generated destination markers reproduced the ambient-force deletion risk before the bundle preflight fix.
- Three bundle regressions passed: preserve a nonempty destination despite force configuration, reject a symlink destination, and serve deployed CLI/UI/assets outside the checkout.
- TypeScript build, production web build, lint, generated-client drift, secret/fixture scan, package boundaries and diff whitespace checks passed.
- One reused subagent reviewed authentication/distribution; fixes addressed player token adoption, canceled-login lifetime and force-configured output deletion.
- Docker daemon unavailable. No Docker/native/Swift/full-matrix rerun; no app adapters, signing/JIT execution or arbitrary browser-core support claimed.
