# Security

Report vulnerabilities privately to the Provenance maintainers. Do not open a public issue containing reproduction details for an unfixed vulnerability.

The server stores bearer tokens and bootstrap tokens as SHA-256 hashes and passwords as Argon2id PHC strings. Give the bootstrap token only to the person creating the owner account, then confirm `bootstrap.token` was removed.

LAN HTTP is for a trusted network. Bind loopback until setup is complete unless `ECS_ALLOW_LAN=1` or `--allow-lan` is explicit. Use `--public` only together with `--tls-terminated` behind a TLS reverse proxy. The content server does not terminate TLS itself in this foundation.

Guest grants do not read BIOS or system files unless the grant includes `share_restricted`. Authorization runs before a blob path is opened.

The content server does not accept Apple ID passwords, signing certificates, or device registration secrets. Its process and database hold none of that material. Signing belongs to a separate app with its own data directory, database, and credential store.
