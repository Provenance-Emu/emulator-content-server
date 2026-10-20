# Library and file management UX

Date: 2026-10-20
Status: written for user review; product implementation has not started.
Branch: `codex/library-ux-design`, isolated from the primary checkout and local main.

## Intent and chosen direction

Make everyday library browsing and file setup understandable without knowing the server's storage model. The user identified excessive folder-selection steps, confusing content-folder/storage-location terminology, long file tables inside settings, and a lack of reusable controls. Both browser and desktop matter; browser comes first. The user selected the familiar Plex and similar media-server interface as the reference.

Use a persistent library sidebar, a focused library browser, library-level folder management, and a separate settings area. Adapt those established interactions to games and their associated files. Preserve existing catalog identities, authorization, saves, downloads, and playback behavior.

References informing the interaction model:

- [Plex interface overview](https://support.plex.tv/articles/200484203-interface-overview/): sidebar libraries, owner actions, item details, and separate settings.
- [Jellyfin libraries](https://jellyfin.org/docs/general/server/libraries/): one virtual library can contain several server folders; library management lives in server settings.
- [Browser directory-relative paths](https://developer.mozilla.org/en-US/docs/Web/API/File/webkitRelativePath): a device folder upload supplies files and relative paths.
- [Tauri dialogs](https://v2.tauri.app/plugin/dialog/): the desktop shell can provide a native directory selector.

The references establish navigation and interaction conventions. The behaviors and scope below are decisions for this project.

## Navigation and layout

The authenticated application has two surfaces:

1. **Library:** left sidebar with server identity, accessible libraries, an owner-only Add library action, and Settings. Selecting a library opens its browser. Its action menu offers Manage folders and Scan library for authorized owners.
2. **Settings:** a separate settings sidebar with Libraries, Upload storage, Access, Activity, and Server status. Back to library restores the previous library view. Administrative sections remain owner-only; account sign-out remains available to everyone.

The library browser has a title/action bar, category tabs, search, system filter, sort, a grid/list switch, a bounded collection, and paging controls. The tabs are Games, Saves, Media, and System files. The main action is Add content, offering Upload files, Upload folder, and, for the server owner, Add server folder.

| Tab | File kinds | Presentation |
| --- | --- | --- |
| Games | ROMs, including supported disc/container sources | Game cards or compact rows; managed items with no files remain visible as empty drafts |
| Saves | Battery saves and save states | File rows with parent game where known, size, state, and conflict indicator |
| Media | Artwork and screenshots | File rows or thumbnails when already available |
| System files | BIOS and other system files | Compact file rows with system and availability |

Games opens by default. Tabs remain visible with useful empty states. No category requires traversing a settings page. Only kinds the actor can read are queried or counted.

Opening a game or file opens a dedicated detail view in the main region, retaining the library sidebar. Back restores the category, query, filters, sort, page, scroll position, and focused result. Detail tabs organize Overview and the applicable file categories. Do not append details or an upload form below the entire library listing. Download, supported Play, and save-conflict adoption remain available in context. Playback continues through the existing isolated player route.

On narrow screens the sidebar becomes a labelled navigation drawer, filters wrap, and details use the full content area. Keep primary actions visible without horizontal page scrolling. Use existing Svelte, CSS, native inputs, selects, buttons, and semantic tables. Game artwork comes only from existing authorized assets; titles and system labels provide a useful fallback.

## Vocabulary and settings

| Visible term | Meaning and supporting copy |
| --- | --- |
| Library | A named collection containing games and related files |
| Library folder | “Files in this server folder appear in your library. They stay where they are.” |
| Upload storage | “Where new uploads are saved. Changing this does not move existing files.” |
| Server folder | A directory on the machine running the selected server |
| This device | The computer or phone running this interface; files selected here are uploaded |

Internal root/location identifiers and protocol enums stay in APIs and diagnostics. Folder names default from the selected path. Name entry is optional, not a prerequisite for folder addition.

Settings > Libraries shows each library's name, folder summary, and management actions. Manage folders shows path, name, last scan/result, online/offline or unknown state, and indexed file count. Counts and scan state come from catalog summaries. Do not fetch file listings or probe every file to render settings. Provide View files as navigation into the library with a folder filter.

Settings > Upload storage shows the built-in default, additional destinations, availability, and the destination receiving new uploads. The default works without configuration. Put Add destination and destination selection here. Removing an in-use destination retains the existing server rejection. New-upload destination selection is not a required step in Add content.

Access, Activity, and Server status reuse existing capabilities and preserve their security behavior. This redesign reorganizes them; it does not add a user-management or monitoring subsystem.

## Main flows

### Create a library

Add library opens one editor with a name and optional server folders. Creating an empty library is valid. Selecting the first folder suggests its basename as the library name unless the user has edited the name. Multiple folders appear as a compact list in that editor; there is no second Add folder form for a selected path. The single final action is Create library.

After confirmation, create the library, register its selected folders, and scan only newly registered folders. These are explicit sequential API operations, not a falsely atomic transaction. If a later operation fails, keep the created library and successful folders, show exactly which folder failed, and retry only unfinished work. Never create another library on that retry. Disable duplicate submission while a request is pending. If creation's response is lost, refresh and ask the user to select the existing library before retrying rather than blindly repeating creation.

### Add a server folder to an existing library

Open a directory chooser in the selected server context. In the web server-folder chooser, the final button is **Add folder**: it registers the displayed directory, closes on success, and starts one scan for that new folder. There is no intermediate Use this folder followed by another Add form. Manual absolute path entry is an alternative in the same chooser, with the same final action. The selected library is implicit.

Cancel writes nothing. Registration errors stay in the chooser with the entered path intact. If registration succeeds but scanning fails, show the saved folder with Scan failed and Retry scan; retry must not register it again. Scan library is an explicit action and scans only that library's folders. Merely opening a screen or adding one folder must not scan other registered folders.

Removing a library folder clearly says that it disconnects the folder and leaves its disk files in place. Confirm that consequence once. Preserve server path-containment, overlap, and duplicate-folder validation.

### Upload from this device

Upload files and Upload folder invoke native browser file inputs, with a supported folder-input fallback to files. The selected library and explicit category provide context. The upload review shows selected files, suggested titles, kinds, system, and relative paths before one Upload action.

Infer a title from the filename and a kind/system only when the explicit context or recognized format makes it unambiguous. Ask for missing metadata in the review; never default to the first system in the server's list. Allow a common system/kind selection for compatible selections. Unknown or conflicting guesses remain visible for correction. Treat each new ROM as its own managed item. For other kinds, require an existing target item in the review; uploading from item details supplies that context automatically. Do not guess associations from similar names. Folder uploads preserve safe relative paths within each item's files, not absolute client paths.

Use a visible sequential queue built on the current chunked upload client, with per-file progress, success/failure, and retry of unfinished uploads. Page the upload review and queue so a large device folder does not produce an unbounded DOM. **Stop after current file** stops scheduling later entries; do not label it Cancel if an in-flight server operation cannot be cancelled. Display successful entries separately so retry cannot knowingly duplicate completed uploads. A lost final response must be reconciled through the existing upload session before offering retry. Browser reload need not persist a newly selected bulk queue in this iteration.

### Add an upload destination

Settings > Upload storage > Add destination uses the same chooser and path/name rules. Its final Add destination registers the directory, without another submission form. Making it the destination for new uploads is an explicit option in that dialog or a subsequent existing row action. Default to retaining the current destination. Preserve restrictions on overlapping library folders, the server data directory, and occupied destinations.

## Existing catalogs and authorization

Uploaded items/assets and scanned source files are distinct existing models. Present both in one library collection through a read projection, preserving their original identifiers and download/player URLs. A managed game appears once in Games; its associated assets appear in the other categories. A scanned ROM remains a source entry. Do not silently merge records by title, copy files, rewrite saves, or convert sources to managed assets.

Legacy folders with no library association remain visible as an owner-only **Unassigned folders** sidebar entry, with the same bounded browsing and a matching section under Settings > Libraries. They retain existing access rules until an explicit owner action assigns one to a library. That action warns that library permissions will apply, updates the folder association in place, and records an audit/change event. Already associated folders cannot be moved between libraries through this iteration's UI. Existing libraries and items require no destructive migration.

Library creation, renaming, folder registration/removal/assignment, storage changes, and administrative settings are server-checked operations. Hide unavailable actions, but never rely on hiding for authorization. Preserve item ACLs, membership restrictions, guest scope/kind restrictions, sensitive-kind defaults, and the existing local-access policy. Owner-only folder paths must not leak through collection results or counts. Handle revoked access and expired sessions without retaining stale private results.

## API and data flow

Add a paginated library-browse read endpoint rather than changing the existing unbounded `/sources` response for existing clients. Its query contains library ID (or an explicit owner-only unassigned scope), category, optional root/system filters, title/name search, sort, cursor, and limit. Return a discriminated result identifying a managed item, managed asset, or source, plus a next cursor. Use 50 entries by default and a server maximum of 100. Offer Next and Previous using retained cursor history; do not invent numbered pages or exact total counts without a corresponding query.

Define category membership, search, ordering, and ACLs in database queries before pagination. Search is case-insensitive substring matching on title/display name; escape SQL wildcard characters so the text is literal. Sort options are Name ascending and Name descending, each with a unique identity tie-breaker. A game belongs in Games if it has a live ROM asset or no live assets; other categories return matching file entries with their parent item where known. Scanned sources use the same category mapping. Unknown systems remain discoverable through an Unknown filter.

The endpoint must not load all manifests or fetch all sources and filter in JavaScript. Probe only source files on the selected page and their distinct roots, with bounded concurrency. Offline entries remain in the results. Cached folder summaries must state their last scan/check time; initial state may be unknown. Return only authorized cached counts. Changefeed updates invalidate the relevant view without triggering scans.

Use opaque, versioned cursors bound to query filters/sort/scope, validate them, and reevaluate authorization on every request. Changing a filter resets cursor history. Preserve the previous visible page during refresh; ignore stale responses and cancel or dispose polling and pending work on logout, server switch, and unmount. A vanished entry or invalid cursor produces an actionable refresh state, not a reset loop.

Add the missing client library-creation method using the existing POST operation. Add narrow owner-only operations for library rename with revision checking, assigning an unassigned root to a library, and root summaries. Protocol additions must preserve v1 compatibility; generate TypeScript and Swift models and intentionally update the surface snapshot. Add indexes or scan-summary columns only through new numbered migrations. Catalog reopening twice must preserve existing rows.

Keep HTTP composition in apps/server, queries and persistence in packages/database, DTOs/cursors in packages/protocol, and UI data access through @ecs/client. Do not put filesystem or catalog access into either interface.

## Reusable components and desktop adapter

Shared web components own behavior, not just colors: application/sidebar shell, category tabs, search/filter toolbar, paginated collection, detail navigation, library editor, folder chooser shell, folder summary rows, upload queue, status/error/empty states, and shared kind/system formatting. Keep components focused and compose them in both interfaces. Use labelled native elements; avoid introducing a general component framework.

Make the shared application accept a ContentClient/server context and a folder-selection adapter instead of constructing its own origin. Browser folder upload and remote server-directory browsing remain separate adapter capabilities.

The desktop currently opens the interface in an external browser. To support native server-folder dialogs, render the shared interface in a **trusted bundled Tauri webview**, while preserving the menu-bar status/service controls and an Open in browser option. Keep native code and dependencies in apps/tray; apps/web must not import Tauri.

Enable the native directory chooser only for the local managed-service profile when native service/process inspection verifies that the selected endpoint belongs to that service on this computer. A loopback-looking URL, discovery advertisement, server-supplied claim, or user-entered address alone is insufficient. Resolve locality through OS service/process metadata, never by reading the catalog/data directory. If verification is unavailable or fails on a platform, use the server-directory chooser and explain which server it is browsing. Remote profiles always use that chooser. Recheck context before submitting a native-selected path; changing servers discards the selection.

For a verified local profile, Add folder opens the OS dialog; its confirmation submits the chosen folder with the inferred label to the selected library directly. Cancelling does nothing. The same adapter serves Upload storage. Native folder selection does not grant the UI arbitrary filesystem reads; registration and all validation remain server API calls. Keep privileged IPC restricted to trusted bundled windows and fixed capabilities. Never load remote server HTML into a webview with privileged commands. Keep credentials scoped to server origin and separate from external-browser storage.

## Accessibility and feedback

Support keyboard navigation and visible focus throughout sidebar, tabs, menus, dialogs, results, and paging. Dialogs have accessible names, contained focus, Escape handling when idle, and focus return. Errors appear beside the relevant action; scan/upload feedback uses live regions without repeated announcements. Use text with status indicators, adequate contrast, and descriptive button names. No action is hover-only. Long paths wrap or have a deliberate copy affordance.

Show actual scan pending/completed/failed states. The existing scan operation has no live numeric progress or cancellation API, so do not fabricate either. Reopening settings reads saved state rather than scanning. Empty states offer the appropriate next action and explain whether the collection is empty, filtered, offline, or awaiting a scan.

## Delivery and acceptance

Deliver in dependency order, with one logical change per PR:

1. Bounded browse queries/contracts and summary/association support, with generated clients and authorization tests.
2. Browser library shell, reusable collection/detail controls, settings separation, and simplified library/folder/upload flows consuming those APIs.
3. Shared desktop application integration and verified-local native folder adapter.

Browser delivery comes first. The desktop phase is part of this design, not a reason to delay the browser interface. Each phase must leave a usable application. Commit and push isolated branches, create PRs, address review and CI failures, and merge only when green under the user's standing integration instructions. Leave the primary checkout and local main untouched.

Write failing behavior tests before implementation. Acceptance must demonstrate:

- Every result after the first 50 is reachable; generated 10,000-entry catalogs return a bounded page and render at most that page's results. Filesystem probes scale with page size, not library size. Filters/search/sort apply before paging, with stable ties and no cross-query cursor reuse.
- Library and source/asset results, summaries, counts, detail actions, and unassigned folders preserve owner/member/guest/item ACL and sensitive-kind rules. A revocation takes effect on the next request.
- Folder choice has one final registration action; cancellation makes no write; duplicate clicks do not duplicate known work. Adding a folder scans only that folder. Opening/navigating settings performs no scans. Failed scan retry does not repeat registration.
- Existing unassigned roots remain accessible without automatic reassignment. Explicit assignment changes permissions in a visible, audited way. Existing source IDs and disk files remain intact.
- Library category/search/page/back state and focus survive opening details and refresh. Repeated navigation does not accumulate polling loops or apply stale requests.
- Device file and folder selection, missing metadata, upload errors, session reconciliation, and retry behave honestly. Upload storage settings do not move existing files. Save conflict adoption still preserves copies; supported downloads and player links still work.
- Real browser acceptance covers owner and restricted sessions, keyboard operation, narrow layout, more than one page of results, empty/offline states, and each add-content path using generated bytes.
- Desktop acceptance covers shared navigation, native selection/cancellation, external browser fallback, server switching, remote profiles, failed locality verification, and privileged IPC isolation. Native work must build on supported CI platforms; do not mark unexercised OS dialogs as manually verified.

Run pnpm verify and Swift tests for contract/client changes. Build the tray when Rust/capabilities change. Add meaningful query-cost and interaction regression tests rather than snapshotting implementation details. No copyrighted ROM/BIOS/disc fixtures or credentials enter commits or logs.

## Scope boundaries and decisions

This is a library/file-management redesign, not a new media platform. Exclude recommendation feeds, metadata scrapers, artwork downloads, new playback cores, additional disc formats, storage relocation/deduplication, library deletion, remote relay, and arbitrary external file associations. Library renaming and folder management provide the editing needed here without adding destructive collection deletion.

Decision: adopt Plex/Jellyfin's library-first organization instead of a separate top-level Folders destination. Cost: folders move into library management, requiring coherent source/asset browsing rather than simply rearranging the old panels.

Decision: introduce a bounded browse projection instead of silently truncating the old sources endpoint. Cost: protocol/database/client work precedes the visible browser redesign; existing integrations retain their current contract.

Decision: use shared bundled desktop UI for real native folder selection. Cost: more work than adding a dialog button to the tray, but an external browser cannot receive a native absolute server path automatically. Remote folders retain an explicit server-side chooser.

Decision: retain explicit metadata review when inference is uncertain. Cost: some uploads still need input; reducing form fields must not misclassify games or attach a save to the wrong item.
