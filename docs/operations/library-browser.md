# Library browser

Open `/ui/` on the content server and choose an accessible library in the sidebar.
Games, Saves, Media, and System files share search, system filtering, name sorting,
grid/list display, and Next/Previous navigation. Each collection request contains
at most 50 entries. Opening details retains the collection page, filters, scroll,
and focused result for Back to collection.

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
