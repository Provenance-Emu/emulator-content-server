# Library maintenance site map

The web and desktop library share the same navigation.

| Location | What the owner does there |
| --- | --- |
| **Home** | Open or create a library, add a folder, or assign a folder already on the server. |
| **Library → Games, Saves, Media, System files** | Browse, search, import, and open items. **Manage → Folders** opens folder registration. **Manage → Library activity** opens the server's job history with actions for that library. **Refresh** reloads the displayed collection. |
| **Game → Metadata, artwork & patches** | Inspect saved details, look up one game, review suggestions, or enter a better lookup title or system under **Improve lookup**. |
| **Settings → Libraries** | Name libraries and add, assign, view, or disconnect folders. **Open Scans & details** goes to maintenance. |
| **Settings → Scans & details** | See whether folders are online, when files were checked, metadata and cover coverage, lookup progress, and interrupted work. Change folder watching or automatic organization here. Review proposed cleanup fixes below activity. |
| **Settings → Storage, Emulators** | Choose server storage and configure playback. |
| **Settings → Access, Devices, WebDAV** | Manage who can reach the libraries and how they connect. |
| **Settings → Plugins, Activity, Server status, Updates** | Manage helpers, view the audit log, diagnose the server, and manage updates. The server audit log is separate from library jobs. |

## Common paths

1. **Add games from a server folder.** In a library, choose **Add games → Add server folder**. Leave watching enabled for future changes. The server queues its first file check and then looks up details and covers for eligible indexed games. In **Scans & details**, watch the file check and lookup as separate stages.
2. **Find a missing cover or title.** Check the folder row for a stopped check, offline drive, catalog outage, or matches awaiting review. Use **Review stopped lookup** to jump directly to an interrupted run. For one game, open its matching panel and enter a more precise title or system identifier, or select a suggested match. Renames and relevant new sidecars also trigger another lookup after the folder is checked.
3. **Recover a missing game.** Reconnect the drive or restore the file. A watched folder will check again. **Check files** in the folder row is the manual recovery action. **Look up details** runs a metadata pass against the games that are already indexed.
4. **Review incorrect details.** Use the game's saved matches, or choose a library under **Library cleanup** to inspect proposals. Cleanup saves the fixes the owner approves and applies.

## Diagnose missing details

- If games are absent or stale, check folder availability and the last file check. Watched folders can resume interrupted checks.
- If games are listed with missing details or covers, open the lookup activity. Provider failures mean a catalog could not complete a lookup. Review results show conflicting or ambiguous candidates. No-match results can benefit from a corrected title, a system hint, or a same-name sidecar.
- Automatic batches keep their work list through restart, and their attempts are recorded per game. Older stopped manual lookups remain available for review. [Matching providers and coverage](matching-plugins.md)

## Remaining path

Direct uploads into server-managed storage use a separate item and asset model. They need a managed-item lookup path before they can share automatic enrichment with indexed folders.
