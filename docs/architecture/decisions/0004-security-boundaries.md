# ADR 0004: Access control and explicit exposure

The first process start binds loopback unless the operator sets `--allow-lan` or `ECS_ALLOW_LAN=1`. `--public` refuses to start unless the operator also asserts `--tls-terminated`. TLS is terminated by a reverse proxy.

Passwords use Argon2id (19 MiB, two iterations, parallelism 1). Tokens are random 32-byte values stored as SHA-256. Library roles are owner, editor, and reader. Item grants add permissions. Guest grants expire, can be revoked, and do not read BIOS or system files unless `share_restricted` is present.

Discovery TXT records contain the server id, display name, API major, TLS flag, and pairing flag. They do not contain tokens, usernames, or library contents.

Signing, JIT, and IPA installation are out of process and out of repository. NAT traversal is out of scope; operators use an existing VPN such as Tailscale or WireGuard.

## Consequences

- Cookie sessions are not implemented, so browser CSRF controls are not required yet.
- A web UI that adds cookies must add CSRF protection in the same change.
- Relay, STUN, and TURN need a new threat model before implementation.
