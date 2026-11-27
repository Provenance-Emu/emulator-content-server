# One server, however the desktop app was pointed at it

Status: design only, nothing built. Date: 2026-11-26. Follows `2026-11-20-local-owner-access-design.md`, section "Servers on the home network".

## The situation

The desktop app on the Mac that runs the server can sign in as the owner without a password, manage updates, and offer native folder choosers. All of that works only for the window whose address is exactly `http://127.0.0.1:<port>`, the "local service" entry.

People do not always arrive that way. They type `localhost`, the Mac's name (`studio.local`), or its network address, or they pick the server from the list of servers found on the network, which names it by its network address. The app then treats its own server as a stranger: it asks for a password, hides the update controls, and uses the server's folder chooser.

The owner asked that every way of naming this Mac be recognised as the same host.

## What was tried and why it was removed

The first attempt handed the sign-in-free owner session to whatever address the window was showing, after checking that the address belonged to this computer. Review found that this sends the session somewhere the server does not control:

- The server holds `127.0.0.1` on its port and nothing else. Its network listener covers every other address only until someone binds one specifically. Another program on the Mac could bind `127.0.0.2`, `[::1]` or the network address on that port and receive the owner session the window sends there.
- "Does this name belong to this computer" was answered by resolving the name and testing the addresses. A name can resolve to this computer when checked and to another machine when the window connects.

The key was never at risk; it only ever goes to the verified loopback listener. The session was.

## Decision

Do not carry trust to the other address. **Move the window to the loopback address instead.** When the app notices that the server a window is showing is the same server it has verified on this computer, it switches that window to the local service entry. From there everything that already works for `127.0.0.1` works, and nothing new is sent to the other address.

"The same server" is decided by the server's identity, not by its address.

## How the app knows it is the same server

Every server already has a permanent identifier. It is created with the catalog and published in the `_pvcontent._tcp` record on the network as `id`. It is not in the HTTP interface today.

1. **Contract (additive).** `GET /api/v1/capabilities` gains `serverId`, the same value the network record carries. It is an identifier, not a secret: anyone on the home network can already read it from the record.
2. **The verified side.** The native side of the desktop app already verifies the local server (`local_endpoint::inspect`). It gains one step: read `serverId` from the verified loopback listener, from Rust, with no proxy and no redirects, as the key exchange does. The managed endpoint answer handed to the bundled windows gains `serverId`.
3. **The window's side.** The window already fetches capabilities from whatever server it shows. It compares that `serverId` with the verified one.
4. **Equal means move.** The window selects the local service entry (`managedProfile`, the same call **Use the server on this computer** makes), and says once, in a line: "This is the server on this Mac. Using it directly."

No name is resolved and no interface is inspected. The addresses the owner listed (`localhost`, the host name, a network address, another loopback address) all fall out of the one comparison, and so does the entry picked from the list of servers found on the network.

## Why a lie does no harm

The comparison trusts an unauthenticated answer from the other address. Consider a server elsewhere that claims this Mac's identifier:

- The window moves to the verified local server. Nothing is sent to the liar: no key, no session, no further request.
- The owner sees their own library where they expected someone else's, with the line above saying why. That is a nuisance a hostile device on the home network could cause, and nothing more.

The reverse lie (this Mac's server reached by another name, answering with a different identifier) cannot happen unless something has already taken that address, in which case not moving is the right outcome.

So the worst case of trusting the claim is a window on the local server, which is where the owner's data already is.

## What moves and what stays

- **Moves:** a window on a manual entry or a discovered entry whose server has the verified identifier.
- **Stays:** a window on any other server; a window when no local server is verified; a server started with `--public`, which offers no local trust and is not verified.
- **The saved list.** The entry the owner typed is kept as they typed it. Selecting it again moves again. An entry is not rewritten or merged, so removing the local service later leaves their list as it was.
- **Sessions.** A session stored for the other address stays where it is and is not copied. The loopback entry gets its own, by the existing key exchange.
- **Folder choosers.** They keep their rule: native choosers only for the verified local entry. After the move the window is on that entry, so they appear. Nothing about that rule changes.
- **The setup code.** `revealSetupCode` is offered for loopback addresses today; after the move it is offered because the window is on the local entry.

## What the owner sees

- Typing `studio.local:8473` on the Studio, or choosing the Studio from the list, lands on the local service with the one-line note. No password is asked for.
- **Connect** to this Mac by another name no longer looks like a second server.
- If the owner wants the other address on purpose (to check what the network sees), a small **Use this address anyway** beside the note keeps the window where it is for that session. Without it the app would fight them.

## Not in this design

- Recognising the same server across two different computers. That is discovery's job.
- Giving any trust to an address the server does not hold. That stays refused.
- Having the server hold more addresses (`[::1]`, each interface). It would shrink the gap the review found but never close it, since interfaces come and go.
- Windows and Linux desktop apps, which do not verify a local server on the home network yet.

## Work

1. Contract: `serverId` on `Capabilities`. `pnpm generate`, `pnpm update-surface`. Additive.
2. Server: return it from `capabilities`.
3. Desktop app, native: fetch it from the verified listener; add it to the managed endpoint answer.
4. Desktop app, windows: compare after capabilities load; move; the note; **Use this address anyway**.
5. Tests: equal identifier moves; different does not; no verified server does not; a server claiming the identifier moves to local and sends nothing more to the claimant; the typed entry is still in the list afterwards; the opt-out holds for the session.
6. Docs: `apps/tray/README.md`, `docs/operations/desktop-install.md`, and the paragraph in the local owner design that says this is not done.
7. One `ecs-reviewer` pass: it changes which server a window talks to.

## Open questions

1. Should the move happen by itself, as proposed, or should the note ask first? Proposed: by itself, because the result is the owner's own server and it can be undone with one click.
2. Should the list of servers found on the network hide this Mac's own entry once the local service is verified? It would remove the second way in altogether. Not proposed here; it changes what discovery shows.
3. A member, not the owner, using the desktop app on the server's Mac under the owner's macOS account would also be moved and then signed in as owner by the key exchange. That is already true of the local service entry today; this design makes it easier to reach. Worth a decision.
