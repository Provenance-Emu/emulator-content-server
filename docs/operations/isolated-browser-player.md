# Isolated local browser player

The threaded `dolphin-wasm-esm` profile uses a separate HTTP origin because its
workers need SharedArrayBuffer. Ordinary cores retain the existing opaque
sandbox. The `/play/` parent keeps COOP `same-origin` and COEP `require-corp`;
its frame policy additionally permits `http://127.0.0.1:*`.

A browser with a read bearer creates a companion with
`POST /api/v1/player/isolated-sessions` and `{ "profileId": "…" }`. The actual
socket peer, request Host, and exact Origin must identify the same local HTTP
browser origin. Forwarded headers and network trust do not substitute for a
bearer. HTTPS, remote browsers, proxy hostnames, and Tauri origins cannot create
these local listeners. Only currently enabled `dolphin-wasm-esm` profiles with
`threaded: true` qualify. The response contains `id`, `url`, and `expiresAt`.
`DELETE /api/v1/player/isolated-sessions/:id` requires that actor and the same
local origin policy; foreign and expired identifiers return 404.

Each companion binds only `127.0.0.1` on a fresh ephemeral port and serves one
fixed, random bootstrap path. Its only file input is the bounded regular
`uiDir/play/dolphin-sandbox.html`, with the single `__ECS_PARENT_ORIGIN__` marker
replaced by the exact JSON origin. It serves no plugin files, games, catalog,
API, directories, tokens, cookies, or CORS responses. Requests carrying Cookie
or Authorization are rejected. Unknown routes, Hosts and methods return 404.
HTTP upgrades and CONNECT are rejected, and sockets, headers and timeouts are
bounded. The bootstrap is first-party code; the browser parent supplies runtime
and original/user-owned content bytes through its private MessagePort.

The companion CSP admits inline/bootstrap and blob scripts, WASM compilation,
blob workers, and blob data connections. It admits no network connections,
including its own HTTP origin. `frame-ancestors` is the exact authorized parent.
COEP is `require-corp`, CORP is `cross-origin`, and the document uses
`sandbox allow-scripts allow-same-origin` on this different origin. Camera,
microphone, location, device, clipboard, fullscreen and wake-lock permissions
are disabled; autoplay, gamepad and cross-origin isolation are delegated by the
parent. The document never receives the API bearer.

There are at most four active sessions globally, two per actor, eight creations
per actor per minute, and 128 retained rate-limit buckets. Allocations expire
after ten minutes. Expiry or DELETE makes the listener a 404-only tombstone;
it does not release its port while an old iframe could still execute. At most
64 origins are allocated per main-server lifetime, after which creation returns
429 until restart. The main server closes all active and tombstone listeners
on shutdown, including allocations that were pending during shutdown. The
parent must destroy its iframe/workers on navigation or server loss. These
bounds do not promise continued gameplay across a server restart.

Focused regressions exercise read authorization, peer/Host/Origin restrictions,
runtime compatibility, ownership, exact HTTP routes and headers, credential
rejection, concurrent allocation limits, expiry, tombstones and shutdown.
Client regressions constrain returned URLs to the expected loopback path and
check that DELETE uses `keepalive` for page-hide cleanup. This companion is not
a general HTTP proxy, static file service, or remote playback endpoint.
