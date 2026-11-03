# Release evidence snapshot — 2026-11-02

Full release readiness is not established. This is an evidence report and bounded
CI closeout, not authorization to publish a release or deploy a public service.

## Source and ownership

At inspection, remote main and both registered checkouts were clean at
`820bb224318cf40651e453f5449f01052abb1a69`. The primary checkout was on main;
the retained Flycast worktree was detached. No separate T3 worktree was
registered, and no external T3/Claude session was contacted. The unique
`codex/ai-library-cleanup` branch and ignored artifacts were left intact.

The #29 manager/cache follow-up has 39 affected server tests, TypeScript build,
lint, boundary and secret-scan evidence. This does not establish a full current
release matrix or app-to-server interoperability.

## Bounded CI closeout

The last [ordinary Linux CI run](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/41551404911)
failed at lint before verification could proceed. The
[main-head Swift CodeQL job](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/41553332157)
failed to compile `PlayerConfiguration.default`; it was a source compilation
failure, not evidence of a completed Swift security analysis.

The closeout escapes `default` in the Swift generator and regenerates the model
without changing its JSON key or OpenAPI contract. A Codable round-trip regression
and all eight Swift package tests pass locally. Client drift checks pass.
The duplicate muted Playwright launch setting is removed, evidence JSON files
are formatted with their parsed values compared unchanged, and shader assignments
are separated from returns. The intentional control-byte rejection regex is
unchanged and carries a narrow lint rationale. Local repository lint now passes
with existing warnings; sandbox syntax, package boundaries and secret scan pass.
No authentication policy, credential or security workflow was changed.

Fresh hosted CI/CodeQL results for this closeout still need confirmation. A local
passing Swift build does not make a failed or pending hosted check green.

## Shipping blocker matrix

| Area | Concrete evidence | Remaining gate or scope limit |
| --- | --- | --- |
| Build and CI | Local #29 checks and eight Swift tests above. Prior Linux CI and Swift CodeQL failures are linked. | Confirm full Linux verification and Swift CodeQL on the closeout commit; other OS/browser/Docker checks remain manual. |
| Artifacts and installation | The [successful nightly matrix](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/41479278573) produced seven server/desktop files from `15d5f93`, with bundled-Node extraction/health/UI/doctor smoke tests and checksum verification. The [nightly release](https://github.com/Provenance-Emu/emulator-content-server/releases/tag/nightly) still names that source. | No current-head installer is verified. Latest nightly predates merged skins and #29. Interactive installation remains tester work; desktop requires a separate server. |
| Signing and platform scope | Nightly notes explicitly say unsigned and not notarized. The matrix covers macOS arm64, Windows x64 and Ubuntu 24.04 x64. Older tagged macOS notarization is documented in [desktop installation](desktop-install.md). | Decide whether delivery is a testing nightly or a signed release. Older notarization does not cover the new source or nightly DMG. Other architectures are unqualified. |
| Configuration and authentication | Loopback bootstrap, owner-only core management, token revocation and access controls have source/tests; [remote-access instructions](remote-access.md) require token mode and explicit public/TLS-proxy flags. | Current-candidate setup and protected-content access through the intended LAN/VPN/proxy path remain unverified here. Discovery/health success is not an authorization test. |
| Storage and recovery | The bounded [verified cache](browser-core-cache.md) has generated-fixture evidence for corrupt bytes, symlinks, offline reuse, conflicts and concurrent activation. [Upgrade/backup instructions](backup-restore.md) are present. | Current release-candidate upgrade, backup/restore and external-drive recovery acceptance are not established by these cache tests. Database downgrade requires a matching backup. |
| Client compatibility | Generated TS/Swift models match OpenAPI; Swift package compilation and eight tests pass after closeout. | No current-head Provenance/iCube/iFly end-to-end browse, remote ROM read and save-sync result is supplied by this server lane. |
| Cores and license scope | Server archives exclude cores, games and firmware. The [exception audit](upstream-core-exceptions-2026-11-02.md) separates upstream pairs from custom builds and content qualification. | N64 remains operator-local under its documented renderer-permission restriction. Complete corresponding-source/notice records as applicable before changing core publication. These limits must remain explicit in release claims. |
| Deployment and docs | [Install](install.md), [nightly](nightly-builds.md), [service](service.md) and [remote access](remote-access.md) instructions exist. | No public deployment was performed. Live proxy/VPN and client interoperability remain separate acceptance; historical documentation must not be presented as a current-head release qualification. |

[#29](https://github.com/Provenance-Emu/emulator-content-server/issues/29) remains
open with unchecked acceptance items. Its immutable local snapshots and verified
cache are implemented; remote channels, installed-version switching/rollback,
complete source/notice distribution and broader format qualification remain
follow-ups. There is no evidence here requiring a separate artifact repository
or a blanket core rebuild.
