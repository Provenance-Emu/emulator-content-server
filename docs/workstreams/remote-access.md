# Remote access

Operators reach a server away from the LAN with Tailscale or WireGuard, or an
operator-managed HTTPS reverse proxy. Follow [Remote access operations](../operations/remote-access.md)
for `token` access mode, VPN-interface binding, and a private proxy backend started
with `--public --tls-terminated`. A host address alone does not enable public mode.

## Status

The remote-access documentation pass is implemented. The guide covers Tailscale
CGNAT IPv4, private and IPv6 VPN trust, owner-only access policy changes, proxy
flags on loopback, ignored forwarded headers, and unchanged same-origin UI/CSP and
WebDAV opt-in. This is operator guidance; no VPN, proxy, relay, or CORS capability
was added. A live VPN/proxy deployment remains operator acceptance work.

## Owned paths

- `docs/operations/install.md`
- `docs/operations/remote-access.md`
- `docs/security/threat-model.md`
- a future `docs/architecture/decisions/0005-relay.md` before any relay code

## Later relay work, only with a new ADR

- Separate process from the content server.
- Authenticated transport, device revocation, quotas, and abuse limits.
- No UPnP in the default configuration.

## Acceptance for the documentation pass

- Install docs link VPN setup and a loopback TLS-proxy backend with both flags.
- Examples match CLI flags and the owner-only `/api/v1/access` body.
- No STUN, TURN, or automatic port-forward code is added.

## Non-goals

Implementing a relay in the foundation.
