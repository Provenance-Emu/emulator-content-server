# Library browser

Open `/ui/` on the content server and choose an accessible library in the sidebar.
Games, Saves, Media, and System files share search, system filtering, name sorting,
grid/list display, and Next/Previous navigation. Each collection request contains
at most 50 entries. Opening details retains the collection page, filters, scroll,
and focused result for Back to collection.

**Refresh details** refreshes the bounded collection page before reading the
opened game's details, so a disconnected or reconnected source folder updates
availability and download controls without a scan.

Owners also see Unassigned folders for legacy folders without a library.
Settings separates library-folder summaries, Upload storage, Access, Activity,
and Server status. Opening settings reads cached folder counts and scan/check
state; it never scans folders. View files applies that folder's collection filter.
Unknown availability means the catalog has no saved check yet.

Upload files is available only when the server grants item creation. Choose a
system explicitly for a new game; an existing game's Add a file action supplies
its context and current revision. Downloads retain original bytes, and choosing
a preserved save copy keeps the previous live save beside it. Play appears only
for an existing supported player profile and uses the isolated `/play/` route.

The current browser release exposes single-file upload and existing upload
storage/access controls. Library creation, renaming, folder registration/scan/
assignment controls, and one-action destination dialogs are the next library
management step. Device-folder selection and bulk upload review/queues follow
that step. No placeholder actions for those flows are displayed.

Authenticated discovery and change-feed checks share one application cadence:
the next check starts 15 seconds after the previous asynchronous cycle completes.
External changes to unassigned folders also refresh the visible collection through
that authenticated cadence even when the legacy change feed has no matching event.
Local UI mutations refresh their affected collection directly. A transient server
failure retains the current page with an error; rejected access clears private
results. An invalid saved cursor requires the visible Refresh action to restart
at the first page with the same filters.

Artwork uses only authorized existing raster assets, with a 2 MiB limit and at
most four concurrent reads. Unsupported artwork falls back to title/system labels.
Preview object URLs are revoked on page/auth/context disposal. The library CSP
permits `blob:` images; script, connection, and isolated-player policies retain
their existing restrictions.

## Browser acceptance

With the pinned Node and pnpm versions installed:

```sh
pnpm install --frozen-lockfile
pnpm --filter @ecs/web exec playwright install chromium
pnpm test:browser
```

The root command builds the server and interface before running Chromium.
For iteration against existing builds, use `pnpm --filter @ecs/web test:browser`.
Tests start temporary real servers on ephemeral loopback ports, use generated
bytes and isolated credentials/catalogs, and clean up afterward. They do not
connect to a running operator server. Traces, videos, and automatic screenshots
are disabled to keep authentication traffic out of test artifacts. Chromium is
installed only for acceptance execution; it is not a runtime dependency.

## Systems and detection

The Systems with games bar shows counts across all readable games in the selected library or unassigned folders, before pagination or system selection. Counts respect folder and search filters. Click multiple systems to include any of them; All systems or Clear systems clears the selection. No empty systems appear. Counts are for game entries (including scanned ROM files and one entry per complete disc set), not unique releases.

Scans use the Provenance system/extension catalog snapshot recorded in `packages/protocol/src/rom-systems.ts`, plus nearest folder name hints, including the registered folder's own name. Shared disc/archive extensions such as CUE, BIN, ISO and CHD do not imply PlayStation. A folder named for Jaguar therefore provides a Jaguar hint; an unhinted CUE stays unknown. These are filename/folder hints, not header or hash identification. Rescan an existing folder to update its cached classification. Source files are left in place. Scanning opens only local CUE/M3U/GDI/CCD descriptors up to 64 KiB; it does not open ROM/track bytes or cloud placeholders.

## Disc sets

CUE/BIN, M3U multi-disc playlists, GDI track sets and CCD/IMG/SUB companions appear as one Games entry after scanning. Referenced members stay available in the game detail with individual downloads. Download complete set as ZIP streams a ZIP64 archive in the original relative layout, including descriptors and subchannel files. The server validates each member and rechecks descriptors before downloading. ZIP bundles do not support ranges. Browser native save streams are used when available; other browsers receive a normal Blob download.

Missing, malformed, cyclic, escaping, unavailable or oversized descriptors remain visible with a group error; unrelated files are never hidden to complete an invalid set. Fix the files and rescan. Former group members become standalone again if a later scan no longer groups them. Existing clients may keep using individual source IDs and content endpoints.
