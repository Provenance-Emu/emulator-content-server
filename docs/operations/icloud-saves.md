# Bringing saves in from iCloud

Provenance keeps the saves made on a phone, tablet or TV in the owner's iCloud. The server can copy them to the matching games in its libraries. It only reads iCloud. The design, and what has not yet been checked against Apple's service, is in `docs/superpowers/specs/2026-11-22-cloudkit-save-import-design.md`.

There are two ways the saves are read. The server uses the first when it can.

- **On the Mac that runs the server.** When the server is on a Mac that is signed in to iCloud and the Emulation Server desktop app is open there, the app's iCloud reader reads the saves with Apple's own framework. No Apple sign-in is asked for, and this works for an Apple Account with Advanced Data Protection. Design: `docs/superpowers/specs/2026-11-26-native-icloud-reader-design.md`.
- **By signing in to Apple in the browser.** Works on any server, but Apple refuses accounts with Advanced Data Protection.

## Turn it on

There is nothing to turn on. The server carries the API token for Provenance's production iCloud container, so **Settings → iCloud saves** is there for the owner on every installation.

The token names the application, not a person, and is the kind of value Apple expects a web page to carry in the open. Reading someone's saves also takes that person's own Apple sign-in, which the server holds in memory and never stores.

To change that, set one of these in the server's environment:

| Variable | Effect |
| --- | --- |
| `ECS_ICLOUD_API_TOKEN=off` | iCloud saves are not offered. |
| `ECS_ICLOUD_API_TOKEN=<token>` | Use your own API token in place of the built-in one. |
| `ECS_ICLOUD_ENVIRONMENT=development` | Read the development database. Needs your own token. |
| `ECS_ICLOUD_CONTAINER=<identifier>` | Read another container. Needs your own token. |

A token of your own is made in the [CloudKit Console](https://icloud.developer.apple.com/) under the container's **Tokens & Keys**, with **Sign in Callback** left at Post Message and any domain allowed, because each household reaches its server at a different address.

When the feature is off, `GET /api/v1/capabilities` leaves `icloudSaves` out and Settings shows no entry.

## Use it

Sign in to the web interface as the owner and open **Settings → iCloud saves**.

1. If the page says the Mac that runs this server is signed in to iCloud, skip to step 2. Otherwise **Connect iCloud** opens Apple's sign-in. Use the Apple account the devices use.
2. **Look for saves** counts what is in iCloud and how much of it belongs to games in your libraries. Nothing is copied.
3. **Bring them in** copies the saves for games you have. Each lands among that game's files under `icloud/`. A save already at the same place is kept, and the new one is put beside it.
4. **Disconnect** forgets the sign-in. Copied saves stay.

The sign-in is held in memory. Restarting the server, or two weeks passing, means signing in again. The Mac route has no sign-in to run out; it is there whenever the desktop app is open and someone is logged in at that Mac.

### Reading on the Mac

- The server and the desktop app must be on the same Mac, under the same macOS account, with the server installed as that account's service (`ecs service install`, or the installer). A server started with `--public` has no Mac route.
- The Mac must be signed in to iCloud, in System Settings, with the Apple Account the devices use.
- The desktop app must be a signed build that includes the iCloud reader. A build you made yourself has none.
- Nothing is written to iCloud, and the reader can hand the server only the saves the server asks for.

## When it does not work

- **"iCloud would not let this account be read from the web."** The Apple account has Advanced Data Protection. If the server runs on a Mac, open the desktop app there and use the Mac route instead. Otherwise turn on **Access iCloud Data on the Web** in the iCloud settings of a trusted device and try again. Apple may still refuse.
- **"Open Emulation Server on the Mac that runs this server."** The server has heard nothing from the desktop app's reader in the last minute. Open the app on that Mac while logged in. After the app or the server starts, it can take up to twenty seconds to appear.
- **"The Mac that runs this server is not signed in to iCloud."** Sign in under System Settings, your name, on that Mac.
- **"iCloud did not let this copy of Emulation Server read Provenance's saves."** A fault in the build, not in your account. Install the current signed build.
- **Some saves "could not be downloaded".** They are tried again the next time you bring saves in.
- **The sign-in window closes and nothing happens.** The browser may have blocked the window, or the desktop app's window cannot receive Apple's answer. Use a browser on the same computer.
- **A game you have is listed as not in your library.** A save is matched to a game in two ways. First by the game file's MD5, which needs the file in a library folder to have been checked: run **Scans & details** for that folder and look again. When that finds nothing and the saves are read on the Mac, the game is looked for by the file Provenance recorded for it: the same system, the same file name and the same size, and only when exactly one file in your libraries fits. That second way is what finds NES, N64 and disc games, whose identifier in Provenance is not the file's plain MD5. It does not help a game whose file you renamed, or one kept twice under the same name in two folders. Unmatched games are listed by name.
- **Battery saves are missing.** This version copies save states only.
