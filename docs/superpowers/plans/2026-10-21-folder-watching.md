# Opt-in folder watching

Continue on main, using generated isolated fixtures. No PR or release-hardening matrix.

- Persist owner consent separately for each registered server folder, default off. Expose owner-only policy/status endpoints and lazy shared web/desktop controls.
- Recursive OS notifications enqueue the existing scanner; event filenames never become filesystem operations or evidence of a move. Coalesce bursts, serialize automatic scans, and retry existing folder reservations.
- Reconcile opted-in folders every 30 seconds to recover offline/replaced roots and missed notifications. Fall back to periodic scans when native notifications are unavailable. Stop queued work on disable/disconnect and await active work before closing the catalog.
- Preserve source identities and saved metadata/artwork using existing verified move detection. Enable both folders for reliable automatic cross-folder detection. Existing verified destination scans can also recover an indexed sibling. Folders must be registered in the same library (or both unassigned), with unambiguous filesystem identity. Cross-volume copies remain distinct files.
- Validate initial indexing, nested cross-folder moves with saved matches, lock contention, disable, offline recovery, restart, consent/authentication, migration reopening, and the shared controls. Run focused builds, drift/boundary/secret checks and one concurrency/lifecycle review, then commit and push main.

## Acceptance notes

- Owner-only consent persists through catalog reopen and server restart. Lazy settings controls work in the shared interface; session rejection clears the modal.
- Generated filesystem tests cover nested moves with saved metadata/artwork, root contention, disable, offline recovery, restart, and default-off roots. Browser acceptance enables watching and immediately renames a file without waiting for the initial scan or calling a scan endpoint.
- Browser acceptance exposed a non-atomic traversal race: one snapshot could contain the old and new names of a single renamed inode. A deterministic regression reproduced two records. Duplicate-identity revalidation now drops stale names before catalog updates while retaining real hard-link ambiguity.
- Review exposed canonical-root replacement between initial validation and traversal. Registered scans now pin the canonical root used by the storage scanner and recheck it immediately before catalog commit. Stable and racing symlink replacement regressions preserve the last good index.
- Focused backend/database/storage checks, web and shared-desktop Svelte checks, web tests/build, browser acceptance, generated Swift tests, drift, boundaries, and secret scan form the batch validation. One reviewer covered runtime, consent, concurrency, and the fixes above.
