---
name: add-migration
description: Use when a change to the emulator content server needs a new table, column, or index in the SQLite catalog.
---

# Adding a catalog migration

1. Find the migration list: search `packages/database/src` for `MIGRATIONS` and read the last two entries to match their style and numbering.
2. **Append** a new numbered migration. Never edit one that already exists, even to fix a typo; write a follow-up migration instead.
3. Make it safe for a catalog with rows in it: new columns are nullable or have a default; backfill in the same migration; no `DROP` of a column or table that holds user data.
4. Add repository methods in `packages/database`. Keep SQL out of `apps/server`.
5. Test in `packages/database/test/`: open a catalog at the previous version with rows in it, migrate, assert the rows survive, then open it a second time and assert nothing changes.
6. `pnpm build && node --test packages/database/dist/test/<name>.test.js`.

A ledger that is not a contiguous prefix of the known versions is a hard error by design. Do not add a code path that guesses.
