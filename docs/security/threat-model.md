# Threat model

## Assets

Library bytes, save data, BIOS and system files, account passwords, bearer tokens, and the audit trail.

## Trusted

The operator who holds the data directory, the host OS, and a TLS proxy the operator
configured. After bootstrap, default `lan` access trusts loopback as the owner and
private/link-local socket peers as library members. `subnets` trusts the specified
CIDRs plus loopback. `token` mode trusts no socket without a bearer credential.

## Untrusted

Guest grant holders, stolen device tokens, and any client on a public interface.
LAN and VPN peers are not inherently trusted: the operator's saved access mode
determines whether those socket addresses receive tokenless access. The default
LAN rule deliberately grants private peers member access; use `token` to require
authentication on those networks.

## Controls

- Bootstrap is a one-time high-entropy token stored hashed, then deleted from disk.
- Passwords are Argon2id. Login and bootstrap are rate limited per address.
- Authorization happens before blob resolution. Relative paths reject absolute, empty, and parent segments. Symlink escape checks cover operator paths.
- Guest default access excludes BIOS and system files.
- Logs redact bearer values. Audit records store ids and names, not raw tokens.
- `--public` requires an explicit TLS-termination flag and disables socket trust,
  including loopback. The CLI does not infer public mode from `--host`; the
  operator must set it for a public deployment. TLS is provided by the proxy.
- Forwarded address headers are ignored for local access and peer rate limiting.
  A loopback reverse proxy must use `--public --tls-terminated` or remote requests
  can inherit tokenless loopback owner access.
- WebDAV is disabled by default and requires bearer or Digest authentication when
  enabled. It never inherits tokenless LAN access. See [WebDAV](../webdav.md).
- The web UI shares the API's origin and carries a strict content security policy.
  Remote deployment does not add CORS origins or relax that policy.

## Accepted risks

LAN HTTP has no confidentiality. Use an encrypted VPN with an interface-bound
listener, or HTTPS with a private proxy backend, and require `token` mode for
remote use. Tailscale IPv4's `100.64.0.0/10` range is excluded from default LAN
trust; private WireGuard addresses and IPv6 unique-local addresses can match that
rule. See [Remote access](../operations/remote-access.md) for the exact deployment
steps and address implications. The in-memory rate limit resets on process restart
and is per process; proxy clients share the proxy socket's bucket.

## Out of scope

Automatic port forwarding, STUN, TURN, relays, Apple signing execution, JIT
activation, and IPA distribution are outside the content server. Signing and
plugin planning may live in this repository, but never inside the content server
process or its database. Remote access uses an operator-managed VPN or HTTPS
reverse proxy. A server relay requires a separate design and ADR.
