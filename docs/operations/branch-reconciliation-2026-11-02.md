# Branch reconciliation — 2026-11-02

The primary checkout began on `main` at `6b28593`, two commits ahead of and
20 commits behind `origin/main` (`15d5f93`). Saved the original local tip as
`archive/pre-t3-main-2026-11-02` before merging remote main into the existing
checkout. The local skins and game-window commits are unique and preserved.

Resolved the two explicit conflicts in the player Playwright configuration and
additional-core acceptance test. Preserved headless operation, unconditional
Chromium audio muting, the local Chromium channel selection and conditional
software WebGL flags. Updated the merged UI mount test to retain the remote
Dolphin loopback iframe permission alongside the local skin resource policy.

Validation passed: TypeScript build, Svelte check with zero errors/warnings,
352 web unit tests, web production build, focused server player/download/catalog/
isolation/UI-mount tests, affected-file Biome check and whitespace check.

The first signing attempt failed with `failed to fill whole buffer`. Retrying
after user authorization succeeded: signed merge commit `036213f` preserves
both histories. Signing stayed enabled. The new #29 batch follows separately.
Original untracked BIOS and cleanup notes were left untouched.

## Branch and worktree disposition

- Fetch/prune removed stale tracking refs for the deleted nightly-distribution
  and Dependabot branches. There are no open pull requests in the repository.
- `codex/ai-library-cleanup` and its remote tip `99cf326` contain two unique
  commits with substantial authentication, schema and workflow work. Retain
  them for issues #27/#28; they are neither merged nor safe to delete as redundant.
- `/private/tmp/ecs-zip-directory-count` is detached at `a96cfd1`, which is
  already in remote main. It retains untracked dependency links.
- The Codex `flycast-wasm-jit/emulator-content-server` worktree is detached at
  `15d5f93`, also in remote main. It retains ignored build/test outputs.
- The Flycast worktree has live processes using its directory, so it remains
  registered and untouched. It must not be archived out from under those sessions.
- The ZIP worktree has no live process using its directory. Its full tree and
  dependency links were archived outside the repository, with SHA-256 comparison
  against all 827 original files/links. The redundant checkout and temporary
  pre-merge backup branch are retired after publication; their commits remain
  reachable from main. The archive is at
  `/Users/jmattiello/Workspace/Provenance/worktree-archives/emulator-content-server/2026-11-02/ecs-zip-directory-count.tar.gz`,
  with an adjacent verification manifest.
