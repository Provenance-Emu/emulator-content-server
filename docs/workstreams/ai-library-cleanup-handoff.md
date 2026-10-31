# Native cleanup checkpoint and MCP follow-up

Updated 2026-10-30. The user explicitly deferred built-in AI-provider/API-key client work and wants MCP primarily for agent control and debugging. This document preserves the current checkpoint; it does not claim the entire original implementation plan is finished.

## Workspace

- Worktree: `/Users/jmattiello/.codex/worktrees/ai-library-cleanup/emulator-content-server`
- Branch: `codex/ai-library-cleanup`, baseline `adbdcb1088cfb780481250151343b579d393cfda`.
- Checkpoint `4752fd9a1e73aa9ab3dcc51f68e82d9736d74c58` is committed and pushed to `origin/codex/ai-library-cleanup` with user authorization. It has not been merged or released. Preserve this unique branch/worktree when archiving the chat.
- Primary checkout has unrelated concurrent changes; do not overwrite it or silently merge this batch.
- Plan/spec: `docs/superpowers/plans/2026-10-29-ai-library-cleanup.md` and `docs/superpowers/specs/2026-10-29-ai-library-cleanup-design.md`.
- Ignored execution ledger, per-task logs and deferred draft: `.superpowers/sdd/2026-10-29-ai-library-cleanup/`.

## Tested active implementation: Tasks 1–9

Versioned workflow/translator/tool contracts; immutable package installation/activation; separate native plugin host; private durable operation state; fenced run leases; scoped host credentials; deterministic no-key library inspection; immutable evidence/proposals/artwork; exact version batch approval; per-source atomic apply; conditional 30-day undo; owner review UI with paging, stale response rejection and lost-response reconciliation. Cleanup does not move or edit original game files or trigger automatic organization.

The browser acceptance test uses a real enrolled native host with the default installed workflow and generated ROM-like bytes/sidecars/covers. It covers close/reopen, two sessions, subset approval/application, reload, undo and 390px layout. The web check passed 258 unit tests and zero Svelte errors/warnings. Focused server/database/host tests, generated-client drift and package boundaries passed in Task 9; full output is retained in its ledger log. No live inference or real credentials were used.

## MCP status and next bounded slice

There is no implemented MCP server or MCP connector in active source. Existing REST evidence/proposal/run contracts are the shared foundation; an external assistant should bring its own inference.

Implement a thin, separate ECS MCP adapter over `ContentClient`, starting with local stdio that can connect to a configured ECS server URL. Provide scoped library/source inspection, cleanup start/status/cancel, paged findings/proposals, redacted host/job diagnostics and untrusted suggestions. Keep durable runs and batch review in ECS. Reuse catalog evidence validation; do not let an assistant claim checksum verification or expand scope through returned text.

Add owner-issued, expiring/revocable investigator grants distinct from owner sessions and workflow-host service credentials. Deny wrong-library access, raw keys, arbitrary filesystem/shell/database access, code installation, and implicit approve/apply authority. Human review remains in the existing UI. Agent inference needs no ECS API key. A local stdio adapter talking to a remote ECS API is sufficient initially; a separately hosted HTTP MCP endpoint/auth-discovery can follow a concrete deployment need.

Acceptance: use the official current MCP SDK and Inspector, test capability discovery/stdio hygiene, permitted tool calls, paging, cancellation, scope/revocation, redaction and suggestion-to-review flow. Verify unsupported/malicious suggestions cannot manufacture approval or schedule paid backend work. Recheck current SDK/protocol docs rather than assuming the old plan’s version guidance is current.

## Deferred work and remaining limitations

- Outbound provider adapters, key management and external-MCP tool consumption are deferred. The incomplete Task 10 draft is preserved outside active source in the ignored execution shelf. Do not restore it as a dependency of inbound MCP.
- Community settings/package-builder work is incomplete; CLI installation/default workflow support exists.
- Retention/GC, coordinated backup/restore/recovery acceptance and the final proportionate independent review from Task 15 remain outstanding.
- Host HTTP calls still need explicit cancellation/deadline handling. Before any future credentials, reject credential-value echoes across worker IPC as well as credential-like property names.
- Runtime should reuse confirmed results without resolving a revoked connection; new dispatch must recheck source scope, grants and budgets.
- Fully missing host state is detected, but stale/partial backup restore needs a conservative recovery marker before supporting paid operations.
- Migration 21 is new and unshipped in this batch; prior migrations were preserved. Keep generated OpenAPI/client/surface files synchronized when extending the MCP investigator routes.

## Checkpoint verification — 2026-10-30

Fresh checks before the authorized local commit passed: TypeScript builds for server/plugin host; 87 focused backend/host/contract/migration/client tests; the web check (258 unit tests, zero Svelte errors/warnings); web production build; one native-host browser acceptance test; generated-client drift; package boundaries; secret/fixture scan; and whitespace validation. Biome checked 79 affected TypeScript/JSON files. The final broader independent review remains a follow-up, as recorded above.

## Local verification

Use Node 22.22.2 from `/Users/jmattiello/.nvm/versions/node/v22.22.2/bin` (prepend to PATH), pnpm 10.30.1, and this worktree explicitly. Follow the repository’s pre-release focused-validation policy; no unrelated emulator/native/Swift/Rust/release matrix is needed.

## Follow-up tracking and core distribution discussion

GitHub now tracks the next actions:

- [#27 — MCP: scoped agent control and debugging](https://github.com/Provenance-Emu/emulator-content-server/issues/27). Includes a permanent link to this handoff at checkpoint `4752fd9`.
- [#28 — Cleanup: artifact retention, backup recovery, and focused review](https://github.com/Provenance-Emu/emulator-content-server/issues/28).
- [#29 — Cores: upstream-first WASM artifacts with pinned catalog updates](https://github.com/Provenance-Emu/emulator-content-server/issues/29). Official compatible binaries are the default; custom builds need a documented gap. A channel points to immutable matched artifacts, and a separate artifact repository is deferred until justified.


The user asked whether to use GitHub tickets/branches, pointing to libretro/virtualjaguar-libretro. Its roadmap issue #371 uses milestones, epics and native sub-issues as planning records, with technical evidence in repository docs. Recommended here: small issues for inbound MCP control/debugging, cleanup retention/recovery/review, and browser-core distribution; short-lived implementation branches tied to issues. The follow-up issues below were created after the checkpoint at the user's request; no project board was created.

The user questioned per-core tags, suggested a single updated bundle or a separate artifact repository, and asked why ECS builds/hosts cores already available from Libretro. Preserve an upstream-first direction: use official compatible artifacts by default, build only missing/incompatible/patched cases, and distinguish building from serving a pinned local cache. The existing dated inventory in `docs/operations/libretro-web-core-inventory-2026-10-28.md` recorded 88 official names, 87 startup-compatible JS/WASM pairs, 35 catalogued profiles and 31 eligible installers; these are historical factory checks, not full game compatibility. Live upstream Emscripten archives remain available. Current custom builds need an individual compatibility/patch rationale rather than a blanket self-build policy.

Recommended publication model if immutable hosting is needed: a small versioned catalog containing exact loader/WASM hashes and source/license/build receipts; a mutable channel pointer may select a complete immutable snapshot. Avoid overwriting one release's individual JS/WASM assets independently, which can mix versions and break pinned installs. Defer a separate artifact repository until storage/release volume justifies it. This is a recommendation, not an implemented packaging change.

Sources inspected: https://github.com/libretro/virtualjaguar-libretro/issues/371 ; https://buildbot.libretro.com/nightly/emscripten/ ; https://github.com/libretro/RetroArch/blob/master/pkg/emscripten/README.md .
