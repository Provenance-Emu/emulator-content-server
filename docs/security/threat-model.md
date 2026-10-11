# Threat model

## Assets

Library bytes, save data, BIOS and system files, account passwords, bearer tokens, and the audit trail.

## Trusted

The operator who holds the data directory, the host OS, and a TLS proxy the operator configured. Loopback clients are the default trusted caller.

## Untrusted

Other LAN devices, guest grant holders, stolen device tokens, and any client on a public interface.

## Controls

- Bootstrap is a one-time high-entropy token stored hashed, then deleted from disk.
- Passwords are Argon2id. Login and bootstrap are rate limited per address.
- Authorization happens before blob resolution. Relative paths reject absolute, empty, and parent segments. Symlink escape checks cover operator paths.
- Guest default access excludes BIOS and system files.
- Logs redact bearer values. Audit records store ids and names, not raw tokens.
- Public bind requires an explicit TLS-termination flag.

## Accepted risks

LAN HTTP has no confidentiality. Use it on a network you trust, or put it behind TLS. The in-memory rate limit resets on process restart and is per process.

## Out of scope

Automatic port forwarding, STUN, TURN, relays, Apple signing, JIT activation, and IPA distribution. Signing may be built in this repository, but never inside the content server process or its database. Remote access in this foundation is an operator-managed VPN.
