# Remote access

Operators reach a server away from the LAN with Tailscale or WireGuard. The server already requires `--public --tls-terminated` for a non-private exposure.

## Owned paths

- `docs/operations/install.md`
- `docs/security/threat-model.md`
- a future `docs/architecture/decisions/0005-relay.md` before any relay code

## Later relay work, only with a new ADR

- Separate process from the content server.
- Authenticated transport, device revocation, quotas, and abuse limits.
- No UPnP in the default configuration.

## Acceptance for the documentation pass

- Install docs name the VPN path and the TLS flag.
- No STUN, TURN, or automatic port-forward code is added.

## Non-goals

Implementing a relay in the foundation.
