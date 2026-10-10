# Adversarial validation

Extend the existing unit tests with hostile inputs. Keep the tests inside the package that owns the behavior.

## Owned paths

- `packages/storage/test`
- `packages/auth/test`
- `apps/server/test`
- `scripts/secret-scan.mjs`

## Cases

- Path traversal, symlink escape, and oversized relative paths.
- Overlapping and gapped upload offsets.
- Archive bombs once a virtual provider exists.
- Token replay after revoke, expired guest grants, and ACL escalation from reader to admin.
- Idempotency key reuse with a different body.
- Multi-range headers and unsatisfiable ranges.
- Sparse multi-gigabyte range reads stay in the storage suite.

## Acceptance

- Each case asserts the HTTP status or thrown error code.
- Tests allocate their own bytes and leave no fixture files.

## Non-goals

Live exploitation instructions, or testing against a production host.
