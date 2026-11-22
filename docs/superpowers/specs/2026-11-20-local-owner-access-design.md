# Local owner access without signing in

Status: built 2026-11-21. Date: 2026-11-20.

## The problem

The desktop app on the computer that runs the server cannot fully manage that server until someone types the owner's name and password into it. Until then it cannot install a server update, manage plugins or players, or issue WebDAV credentials, and in `token` access mode it can do nothing at all. The person at that computer already owns the files, the catalog, and the service registration; asking them to sign in to their own server protects nothing and reads as broken.

What exists today:

- `packages/auth/src/network.ts` treats a loopback peer as `owner` in the `lan` and `subnets` access modes, and `apps/server/src/local-access.ts` admits it with no token once an owner exists. That covers the library, accounts, and most of Settings.
- The routes that matter most refuse it anyway and demand a bearer session: server updates (`server-updates.ts`), plugin management, the player manager, player isolation, and WebDAV credentials. They are right to. A loopback socket proves only that the caller is on this computer: another account on a shared Mac, any local program, a web page reaching `127.0.0.1`, or a remote request arriving through a loopback proxy that was not started with `--public` would all qualify.
- In `token` mode nothing is trusted by address, so the desktop app starts signed out of its own server.
- The desktop app already proves the reverse direction. `local_endpoint.rs` checks that the listener belongs to the service registration, to its supervisor, and to the same user id before it calls a server "managed".

What is missing is the server knowing that the caller is the same operating-system user, not merely a local socket.

## Decision

Prove same-user access with a key file in the data folder, and exchange it over loopback for an ordinary owner session.

1. **Key file.** Once its listener is bound, a server with local trust enabled (anything but `--public`, and not on Windows) writes `local-owner.key` in the data folder: 32 random bytes, base64url, mode `0600`, created with exclusive-create after removing any earlier file. The server keeps only the SHA-256 in memory. A new key is written at every start, and the file is removed on a clean stop.
2. **Exchange.** `POST /api/v1/auth/local` with `{ "key": "…" }` answers like `login` (`token`, `tokenType`, `userId`, `expiresAt`). It succeeds only when all of these hold:
   - the socket peer is loopback (the peer address, never a forwarded header);
   - local trust is enabled and an owner exists;
   - the key's hash matches, compared in constant time.
   The session it mints belongs to the owner user, is a normal `session` token with the normal 12-hour life, and does **not** carry `localTrust`, so every owner-only route accepts it unchanged. It is rate limited as its own bucket and audited as `local-sign-in`. A wrong key is `401` and audited as `local-sign-in-failed`, with no key material in the row.
3. **Desktop app.** A native command, available only to the bundled status and library windows, re-runs the existing managed-endpoint verification, reads the key from the data folder named in the launchd registration (`O_NOFOLLOW`, regular file, owned by this user, mode `0600`, bounded size), and posts it to the verified loopback origin from Rust. The key never enters the webview, IPC, a log, or a URL. The webview receives the session and stores it exactly as a typed sign-in is stored today.
4. **When it runs.** Whenever the server offers it and the app holds no session for it, at most once every 30 seconds. An expired or refused session is dropped first and replaced on the next ten-second poll. The shell answers only for the server it has verified, so a server on another computer never gets one.
5. **Capabilities.** `features.localOwnerSignIn` is `true` only when the server wrote a key this run, so the interface offers nothing the server will refuse.

## Why this is no weaker than today

Whoever can read a `0600` file in the data folder can already read and rewrite `library.sqlite` beside it, including inserting a session row. The key grants nothing that file access does not already grant; it gives that same person a supported door instead of a locked one.

It is stricter than loopback trust:

| Caller | Loopback trust today (`lan`, `subnets`) | Key exchange |
| --- | --- | --- |
| The owner's own desktop app | library and accounts; no updates, plugins or players | owner session |
| Another account on the same computer | the same as the owner's app | refused: cannot read the file |
| A web page fetching `127.0.0.1` | the same, subject to CORS | refused: cannot read files |
| A remote request through a loopback proxy started without `--public` | the same | refused: cannot read files |
| Another device on the network | per access mode | refused: not loopback |
| A server started with `--public` | no local trust | no key is written |

`token` access mode keeps its meaning for the network: nothing is trusted by address. The key exchange still works there, because it is not address trust; it is proof of file access plus loopback.

## What this unlocks

With an owner session the existing interface already does the rest, so no second control channel is needed: server updates (`ServerUpdatePrompt.svelte`, `/api/v1/server/updates`), plugins, players, WebDAV credentials, and everything in `token` mode.

## As built

- `apps/server/src/local-owner-key.ts` writes and removes the key. `ecs serve` calls `offerLocalOwnerSignIn()` after `listen` succeeds, so a second process that cannot bind never replaces a running server's key. Windows, `--public`, and a data folder that cannot take the file leave the feature off and the server running.
- `POST /api/v1/auth/local` is in `routes.ts` beside `login`. Order of checks: feature on, loopback peer, rate limit, owner exists, key.
- `apps/tray/src-tauri/src/local_owner.rs` reads the key and performs the exchange with no proxy, no redirects, and a five-second limit. The `local_owner_session` command takes the origin the page is showing only to compare it with the verified one, so nothing is minted for a different server.
- `AccessDesk` (`apps/tray/src/lib/access.ts`) asks when the server offers it and there is no session, at most once every 30 seconds. **Sign out** in the status window pauses it until **Sign in on this Mac**, switching servers, or reopening the app; a new session is stored where a typed sign-in is stored, so the library window picks it up.
- Guessing is limited to the sign-in limit per minute for loopback as a whole, and each wrong key is one audit row. Another local program can use that up, which sends this computer back to the password form for a minute; it cannot get in.
- The status window's ten-second poll is what notices an expired session, so the library window can show its sign-in form for a few seconds before the new session arrives.

## Not in this design

- **A privileged helper.** The login service and the boot service both run as the installing user, so the desktop app and the server are the same user and nothing needs raising. The administrator prompt is needed only to start or stop the boot job, which `service.rs` now does.
- **First run without choosing a password.** Local setup still shows the owner form with the setup code filled in. Creating the owner automatically (named after the macOS account, password set later for other devices) is a separate product decision; this design makes it possible but does not do it.
- **Windows and Linux.** No key is written on Windows, where a file mode cannot keep it private; that needs an ACL. A Linux server writes the key, but the desktop side reads it on macOS only for now.
- **Changing what loopback trust admits.** Every route that demanded a bearer session still does.

## Work

1. Contract: `localSignIn` operation, `features.localOwnerSignIn`; `pnpm generate`, `pnpm update-surface`. Additive.
2. Server: key lifecycle in `apps/cli` serve start/stop, route in `apps/server`, `localSignIn` in the catalog (session + audit), rate-limit bucket.
3. Client: `ContentClient.localSignIn`.
4. Desktop: native command, `AccessDesk` use for the managed profile, menu items for updates.
5. Docs: ADR 0004 addendum, `docs/security/threat-model.md`, `docs/operations/desktop-install.md`.
6. Tests: wrong key, non-loopback peer, `--public`, before bootstrap, rotation on restart, audit rows without key material, file mode and symlink refusal on the desktop side.
7. One `ecs-reviewer` pass: this is an authentication change.
