# RomM gateway for Manic EMU

The optional gateway serves the RomM browse and download routes that Manic EMU uses. It runs beside Emulation Server and uses that server's library permissions. The gateway keeps a separate SQLite index for the numeric ROM IDs that Manic stores with its imports.

## Run the gateway

From the repository root, with the workspace dependencies installed and Emulation Server running:

```sh
pnpm exec tsc -b apps/romm
ECS_SERVER=http://127.0.0.1:8473 \
ROMM_GATEWAY_HOST=127.0.0.1 \
ROMM_GATEWAY_PORT=8474 \
ROMM_GATEWAY_INDEX="$PWD/romm-gateway.sqlite" \
node apps/romm/dist/src/main.js
```

For access from a phone or tablet, set `ROMM_GATEWAY_HOST` to the server's private LAN address. Set `ROMM_GATEWAY_INDEX` to a writable location outside the checkout for a persistent installation. Keep the same index when upgrading or restarting the gateway so Manic's existing ROM links continue to work. If the upstream origin changes, use a separate index.

## Connect Manic

1. In Emulation Server, open **Guest grants** and create a grant with **Read** for the library you want to browse. Copy the token when it appears.
2. In Manic's import screen, add a **RomM** service. Enter the full gateway URL using the Studio LAN IP and port, for example `http://192.168.1.112:8474`. Manic's current setup form expects a private IPv4 address.
3. Leave the username blank. Paste the read token into **Password / API Key**, then connect and pick a platform.

The gateway forwards the token on each request. A revoked or expired token stops working immediately. HTTP is suitable on a trusted LAN. Use HTTPS when sending credentials over a network you do not trust.

Single files retain their filenames and support byte ranges. Multi-disc games download as a ZIP with their playlist and discs. For an M3U that directly references discs with unique names, the gateway puts the files beside the playlist and rewrites its entries to match Manic's basename lookup. Other groups retain their existing layout. Arcade bundles use a distinct outer filename and preserve the cartridge ZIP and its matching CHD subfolder inside. Check that Manic retains the CHD folder and the RomM link when importing an extracted group before using it for save sync.

## Supported routes

All routes below except `/health` take an ECS bearer token. These examples show the requests Manic makes. Substitute an ID from the preceding list response.

| Method | Example | Response |
| --- | --- | --- |
| GET | `/health` | Gateway process liveness |
| GET | `/api/platforms` | Platform array with numeric IDs and catalog counts |
| GET | `/api/roms?platform_ids=123&limit=250&offset=0` | A page of ROMs. Use `search_term` for text search |
| GET | `/api/roms/42` | ROM details including its download filename |
| GET, HEAD | `/api/roms/42/content/Example%20Game.iso` | File or ZIP download |
| GET, HEAD | `/assets/romm/ecs/42/cover` | Cover bytes when ROM details include a cover path |
| GET | `/api/saves?rom_id=42`, `/api/states?rom_id=42`, `/api/play-sessions?rom_id=42` | Empty lists during browse-and-download testing |

Save sync is pending. For grouped games, verify that Manic carries the RomM ID from the downloaded ZIP to the imported game. Manic currently records that link by download filename and looks it up by imported filename. Its manual uploads request overwrite, so the gateway needs a per-user write identity and revision checks that preserve conflicting bytes. Save states need separate storage by Manic core to keep formats from mixing.
