# Remote access

Reach ECS through an operator-managed Tailscale or WireGuard VPN, or through an
HTTPS reverse proxy. Finish [local setup](install.md#local) and create the owner
before exposing a listener beyond loopback. Keep an owner session available when
changing the access rule. ECS does not configure the VPN, certificates, firewall,
port forwarding, or a relay.

## Require bearer authentication

For remote use, select `token` access mode in the tray's access settings, or send
the owner-only API request below while the server still listens on loopback.
Sign in with `POST /api/v1/auth/login` to obtain an owner session first. Replace
the example placeholder locally; never commit or share a real credential.

```sh
curl --fail-with-body -X PUT http://127.0.0.1:8473/api/v1/access \
  -H 'authorization: Bearer <owner-session-token>' \
  -H 'content-type: application/json' \
  -d '{"mode":"token","subnets":[]}'
```

The rule is saved in the catalog. `token` mode requires a bearer credential even
on loopback; VPN membership alone does not grant ECS permissions. Sign in through
the web UI at the VPN address, or use a session/device/guest bearer credential
with the API according to its existing scope and library permissions. A token
from one server does not authenticate to another.

`GET /api/v1/access` reports `mode`, `subnets`, `applies`, `trusted`, and `manages`.
The last two fields describe tokenless socket trust, not the signed-in account's
role. In `token` mode they are false. `applies` is false when `--public` has disabled
socket trust for the process, regardless of the catalog's saved mode.

## Bind to the VPN address

For Tailscale, install and authenticate the client on the server and the devices
that will connect, following the [official quickstart](https://tailscale.com/docs/how-to/quickstart).
Use the server's assigned VPN address and allow only the intended peers to reach
TCP port 8473 in your VPN and host firewall policy. Tailscale assigns IPv4 addresses
from the CGNAT range `100.64.0.0/10`; see its [address documentation](https://tailscale.com/docs/concepts/tailscale-ip-addresses).

For WireGuard, configure the interface, peer keys, addresses, and routing using
the [official quickstart](https://www.wireguard.com/quickstart/). Bring the tunnel
up before ECS and use the server's tunnel address. WireGuard peer configuration
and ECS bearer authentication are separate controls.

After selecting `token` mode, stop the loopback process and start it bound to the
actual VPN interface address. This illustrative address must be replaced with the
address assigned to your server:

```sh
pnpm ecs serve --data ./content-data --host 100.90.80.70 --port 8473
```

For a WireGuard server assigned `10.20.30.1`, the corresponding example is:

```sh
pnpm ecs serve --data ./content-data --host 10.20.30.1 --port 8473
```

Open `http://<server-vpn-address>:8473/ui/` from a VPN peer and sign in. Use that
same base address for API clients. HTTP here relies on the encrypted VPN transport;
keep the listener and firewall limited to that tunnel. For browser features that
require a secure context, use HTTPS through the proxy described below. There is
no need to publish the ECS port on the router or use `--advertise` for remote
clients. mDNS is local discovery, not VPN routing. A loopback-only listener cannot
be reached directly through the server's VPN address; `0.0.0.0` would also expose
the port on other IPv4 interfaces.

### Address-based trust is not VPN authentication

The default `lan` rule trusts loopback as the owner and private/link-local socket
peers as library members without a bearer token. It excludes `100.64.0.0/10`, so
a direct Tailscale IPv4 peer needs a token even with that default. It includes
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, IPv4 link-local, IPv6 unique-local
`fc00::/7`, and IPv6 link-local `fe80::/10`. A WireGuard peer using private IPv4,
or a VPN peer using IPv6 unique-local addresses, can therefore receive tokenless
member access under `lan`. In particular, Tailscale's [private IPv6 prefix](https://tailscale.com/docs/concepts/ipv6)
is `fd7a:115c:a1e0::/48`, which falls inside the trusted unique-local range.
Selecting `token` avoids different authentication behavior between the VPN's
address families.

The optional `subnets` rule explicitly trusts named CIDRs as members, in addition
to loopback owner access. Do not add the VPN range merely to make connectivity
work: that opts those peers into tokenless access. ECS evaluates the socket peer,
so a subnet router or other NAT can also change the address ECS sees.

## HTTPS reverse proxy

For a proxy on the same host, keep the ECS backend on loopback and start it with
both flags, even though its bind address is private:

```sh
pnpm ecs serve --data ./content-data --host 127.0.0.1 --port 8473 --public --tls-terminated
```

Configure your proxy to serve a certificate at your HTTPS hostname and forward
to `http://127.0.0.1:8473`. Preserve `/api/v1`, `/ui/`, request bodies, Authorization,
Range, conditional headers, and streaming responses. Keep that backend port
inaccessible from outside the host. For a separate proxy host or container, use a
private backend network and firewall rules that admit only that proxy; loopback
belongs to each host/container and does not cross that boundary.

`--tls-terminated` records the operator's assertion that TLS is provided upstream;
ECS itself still speaks HTTP. `--public` requires that flag and disables tokenless
socket trust, including for `127.0.0.1`. Omitting `--public` behind a loopback proxy
can let remote requests inherit loopback owner access. A non-loopback host alone
does not automatically select public mode: the operator must supply `--public`
for an internet-facing deployment.

`Forwarded`, `X-Forwarded-For`, and other forwarded address headers do not confer
trust or change the socket peer used for rate limiting. Requests through one
proxy share the backend's peer rate-limit bucket. Keep `token` as the saved access
rule as well, so restarting without `--public` does not restore LAN trust.

Serve the UI and API at the same HTTPS origin. Keep the existing strict content
security policy; this deployment adds no CORS origins or relay. Do not strip the
server's security headers to work around proxy configuration.

## Other operator features

- [WebDAV](../webdav.md) stays opt-in with `--webdav` or `ECS_WEBDAV=1`. Its
  read-only mount requires bearer or Digest credentials even on a trusted LAN.
  Preserve its exact URI, methods, and challenge headers as described there.
- [Service installation](service.md) records the listen flags for login-time
  startup. Reinstall the registration with the intended VPN address or proxy
  flags, and ensure the VPN is available before a service binds its address.
- [Storage locations](storage-locations.md) and [backups](backup-restore.md) work
  the same way remotely; filesystem paths always name directories on the server.

For a deployment check, inspect `/api/v1/access` through the intended URL and
confirm a protected library request without a token returns 401, then sign in and
read a library you are allowed to use. Repeat for each VPN address family you
expose. `capabilities` and `access` are public discovery endpoints, so a successful
response from either does not prove authentication is enforced on content.
