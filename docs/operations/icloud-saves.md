# Bringing saves in from iCloud

Provenance keeps the saves made on a phone, tablet or TV in the owner's iCloud. The server can copy them to the matching games in its libraries. It only reads iCloud. The design, and what has not yet been checked against Apple's service, is in `docs/superpowers/specs/2026-11-22-cloudkit-save-import-design.md`.

## Turn it on

The server needs an API token for the app's iCloud container. It identifies the application, not a person.

1. In the [CloudKit Console](https://icloud.developer.apple.com/), open the container `iCloud.org.provenance-emu.provenance`, then **Tokens & Keys** and **New API Token**.
2. Leave **Sign in Callback** at its default, which hands the result to the window that opened the sign-in. Allow any origin, because each household reaches its server at a different address.
3. Start the server with the token in its environment:

   ```sh
   ECS_ICLOUD_API_TOKEN=… ./ecs serve --data "$HOME/EmulationServerData"
   ```

   For an installed service, add the variable to the service's environment. `ECS_ICLOUD_ENVIRONMENT=development` and `ECS_ICLOUD_CONTAINER` select the development database or another container.

Without the token, `GET /api/v1/capabilities` leaves `icloudSaves` out and Settings shows no entry.

## Use it

Sign in to the web interface as the owner and open **Settings → iCloud saves**.

1. **Connect iCloud** opens Apple's sign-in. Use the Apple account the devices use.
2. **Look for saves** counts what is in iCloud and how much of it belongs to games in your libraries. Nothing is copied.
3. **Bring them in** copies the saves for games you have. Each lands among that game's files under `icloud/`. A save already at the same place is kept, and the new one is put beside it.
4. **Disconnect** forgets the sign-in. Copied saves stay.

The sign-in is held in memory. Restarting the server, or two weeks passing, means signing in again.

## When it does not work

- **"iCloud would not let this account be read from the web."** The Apple account has Advanced Data Protection. Turn on **Access iCloud Data on the Web** in the iCloud settings of a trusted device and try again. Apple may still refuse.
- **The sign-in window closes and nothing happens.** The browser may have blocked the window, or the desktop app's window cannot receive Apple's answer. Use a browser on the same computer.
- **A game you have is listed as not in your library.** The save is matched by the game file's MD5. A file in a library folder is found only after it has been checked: run **Scans & details** for that folder and look again.
- **Battery saves are missing.** This version copies save states only.
