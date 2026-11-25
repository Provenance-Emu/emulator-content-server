# Web design language

Emulation Server is a compact utility for people finding and organizing their games. Keep the quiet surfaces, muted text, blue selection, plain labels, and native buttons. The blue is the Provenance app blue; the dark theme uses charcoal surfaces and the light theme uses white panels on a pale grey canvas. Use readable system fonts, modest headings, and left-click/touch actions. Avoid making settings feel like a landing page.

## Global customization

`apps/web/src/app.css` starts with the theme entrypoint. Edit semantic tokens there to change the shared web interface and the desktop interface that imports it:

| Change | Tokens |
| --- | --- |
| Text, backgrounds, borders | `--color-text`, `--color-text-muted`, `--color-canvas`, `--color-surface`, `--color-surface-inset`, `--color-surface-muted`, `--color-border`, `--color-border-strong` |
| Buttons and selection | `--color-control*`, `--color-primary*`, `--color-on-primary`, `--color-selected*`, `--color-accent` |
| Feedback | `--color-danger`, `--color-success` |
| Type | `--font-body`, `--font-mono`, `--text-body`, `--text-label`, `--text-small`, `--leading-body`, `--weight-medium`, `--weight-semibold` |
| Rhythm and panels | `--space-1` through `--space-6`, `--space-8`, `--panel-padding`, `--content-measure` |
| Shape | `--border-width`, `--radius-sm`, `--radius-control`, `--radius-panel`, `--radius-dialog`, `--radius-pill` |
| Controls | `--control-height-touch`, `--control-height-desktop`, `--control-padding-block`, `--control-padding-inline` |
| Focus and motion | `--focus-width`, `--focus-offset`, `--focus-color`, `--motion-control`, `--motion-surface`, `--ease-out` |
| Depth | `--shadow-control`, `--shadow-panel`, `--shadow-raised`, `--shadow-popover`, `--color-highlight`, `--color-hover`, `--color-sidebar` |

### Surfaces, depth and motion

Depth comes from tokens, not from borders drawn in a component. Borders are translucent hairlines (`--color-border`), panels sit on `--shadow-panel`, anything floating (filter panel, Manage menu, dialogs) uses `--shadow-popover`, and hover lift uses `--shadow-raised`. `--color-hover` is the resting-to-hover tint for quiet rows; `--color-sidebar` is the navigation column. Every transition uses `--ease-out` with `--motion-control` (controls) or `--motion-surface` (cards, drawers); animate only `transform` and `opacity`. Dialogs fade without moving because their contents are measured and focused as they open. Reduced motion turns all of it off.

Icons come from `components/Icon.svelte`: one light stroke on a 24px grid, always decorative beside a visible label or inside a control with an `aria-label`. Add a glyph there instead of inlining an SVG.

### Shell

The library sidebar and the Settings sidebar occupy the same `--sidebar-width` column, so opening Settings swaps the list without moving the page. The server name carries a status dot that reflects whether the server is answering; never colour it from anything else. Setup guide, Settings, sign-in and Appearance stay at the foot. Content inside `.application-content` gets mouse density on fine pointers; touch keeps 44px.

Home shows one tile per library from `components/LibraryTiles.svelte`: up to four covers, the name, and a game count. `lib/library-tiles.ts` reads one bounded page of the same authorized `browse` the collection uses (the count is the sum of `systemCounts`), so a tile never counts a game its viewer cannot open, and it reloads when the catalog changes. A library that cannot be summarised keeps a plain tile.

A settings page is a heading followed by panels (`section` with an `h2`); nothing sits loose on the canvas. A `section` inside a `section` is an inset, not a second card. Forms align their fields and button on the bottom edge. A status dot is green only for something that is working and red only for a failure; a feature that is simply switched off stays neutral.

The desktop library window pins its connection bar and publishes its height as `--shell-offset`; the sidebars and the phone header sit below it. Leave the variable unset in the browser.

`Status.svelte` (shared with the desktop status window) shows one headline state, then `.status-facts` and `.status-features`. `.link-list` is the row style for outbound documentation links.

### Light and dark

The colour tokens have a dark set and a light set. With no choice saved the page follows the system (`prefers-color-scheme`). **Appearance** in the sidebar saves `light` or `dark` in `localStorage` under `ecs.theme`, and `lib/theme.ts` sets `data-theme` on the root element before the app mounts; the tray entry points call the same function. The light values are written twice in `app.css`, once inside the media query and once under `:root[data-theme="light"]`. Change both together.

Never write a colour in a component. Covers and placeholders use `--color-artwork-*`, highlighted panels use `--color-feature*`, and cautions use `--color-warning`. The player page has its own stylesheet and stays dark.

### Collection toolbar

Everything is on the page; nothing opens. One row holds search, **Library folder**, **Sort**, and the Grid/List switch. Search filters as you type after a short pause (Enter applies it at once), so there is no Search button. Under that row the systems that have games are always visible as chips with their counts. One click shows one system and clicking it again shows all; Shift, Ctrl, or Command adds to the choice. On a mouse the chips fold to two rows behind **More systems**, and never hide a chosen system; on a phone they scroll sideways in one row. Chips are 1.75rem pills for a mouse and full touch height on any coarse pointer. Chips are ordered by `lib/system-order.ts`: the systems someone opened games from lately on this device come first, then the largest. Each chip shows its system's picture from `components/SystemIcon.svelte`, which draws RetroArch's Monochrome icons (CC BY 4.0, recorded in `src/assets/systems/NOTICE.txt`) as a mask so they take the text colour; a system without a picture shows its name alone. From eight systems up the row starts with a **Find a system** field: typing narrows the chips by name or short identifier, Enter chooses the first one left and Escape clears it. It only narrows what is shown; the games change when a chip is chosen. From twelve systems up the chips are grouped by `maker` from the systems list (`groupSystems` in `lib/system-order.ts`): the systems opened lately lead as **Recent**, makers follow with the most games first, and systems without a maker end the row as **Other**. A group is its name set beside its first chip in the same wrapping row, not a heading or a new line, so folding and the phone's sideways row work as before.

**Recently played** (`components/RecentGames.svelte`) is one sideways-scrolling row of small covers above the games, newest first, for what this account last played on any device. It has no panel of its own, shows only on the Games tab with nothing filtered, and disappears when there is nothing to show. A cover opens the game the way a card in the grid does. The list comes from the server (`browse` with `played: 'recent'`), which decides what may be listed; the browser keeps no copy. **Clear filters** appears beside the chips only while something is filtered. Add a new filter to `.collection-view-options`, not behind a disclosure.

### Long lists

No list has Previous and Next. A long list starts with one bounded batch and grows downward: more is added while its end is within a screen of the viewport, and the foot of the list says how much is shown (`Showing 100 of 1,240`, then `1,240 games`). `components/ListMore.svelte` is that foot for every list. Its button (**Show more**, or a named one such as **Show more files**) is the same action for a keyboard, and becomes **Try again** after a failed read, which is never retried on its own. Nothing already on screen moves or is replaced when more arrives. The contracts page by cursor and report no offsets, so numbered pages are not available.

- The grid is covers first: columns are `8.5rem` at least (`6.5rem` on a phone, three across), a name takes two lines at most, and one quiet line under it says the system and file type. A card says where a game is only when something is wrong (`Not downloaded`, `Disk offline`). Do not add a line that every card would carry. **Cover size** in the toolbar (`lib/cover-size.ts`, kept on the device) sets the narrowest a cover may be; the grid fits as many as it can. Arrow keys, Home and End move between cards as they look on screen, and Tab still visits every card.
- The collection: `lib/library-browser.ts` reads batches of 50 and keeps them. A refresh reads everything on screen again and swaps it in together. Covers are requested only for cards near the viewport (`CollectionPage.svelte` reports them, `previews.request` keeps at most 240 and releases the oldest), so a long scroll does not hold every image in memory. This is the one list whose count is announced (`announce`).
- Lists the server pages (Library activity results, cleanup fixes, findings and saved batches, the game list when adding files): the controller remembers how many batches are shown and a refresh reads that many again with `readBatches` in `lib/batches.ts`, so a list that refreshes on a timer does not fall back to its first batch. Marking one result reviewed keeps the list where it was; another filter or another job starts a new list.
- Lists already in memory (upload review, the upload queue, player skins): fifty rows, and fifty more each time.
- Lookup suggestions show eight and add eight only when **Show more matches** is pressed (`auto={false}`), because each suggested picture is fetched from its provider.
- A footer with nothing more to offer is left out of a short secondary list. Use `shownLabel` for the wording so every list counts the same way.

### Adding games

**Upload files** (`Upload.svelte`) is three steps in one dialog, and each shows only what needs a decision.

- **Choose.** A drop zone with **Choose files** and **Choose a folder**. The file inputs stay in the page with the names `File` and `Folder`, visually hidden behind the buttons. Once something is chosen the zone shrinks to one row.
- **Review** (`UploadReview.svelte`). One line per file: its name, then what uploading it does (`New game · NES`, `Battery save for Sonic`), then the folder it came with. A file that still needs a choice gets a warning edge and one sentence saying what is missing; the head of the list counts them. **Choose game** sits on the row; **Edit** opens the title, kind and system fields, which stay in the page while closed. **System** applies one system to every game; **Kind for all files** is under **More options**.
- **Queue** (`UploadQueue.svelte`). Overall progress, then unfinished files first with plain states (Waiting, Uploading, Did not finish, Needs a check) and sizes in readable units. Uploaded files fold away once there are more than twelve. The queue changes its rows in place, so its lists read the store directly; a `$derived` list of the same row objects is not drawn again.

A game is chosen from `UploadTargetPicker.svelte`: a search box and rows of cover, name and system, read from the same listing the collection uses, twenty-odd rows tall and scrolling inside the dialog. It never shows an identifier. Games kept in a server folder cannot take uploaded files yet, so they are left out and a line says so when any were.

### Library activity

`LibraryJobs.svelte` has two faces and shows one at a time.

- **Overview.** The two things to start (**Find missing artwork and details**, **Check folder files**), then one card for the selected run: its state, a progress bar, and its result counts as a row of toggles (`2 need review`, `2 unmatched`, `0 failed`, `0 saved`, `0 skipped`, **All**). A count is the filter for the list under it; there is no second control. Rows say what happened in words (`Needs review · 1 suggestion`). Options are one disclosure: the two choices people make are on top, and **Choose where to look** holds the sources by name, without versions or identifiers.
- **Review.** Choosing **Review** replaces the overview with one game: its name, what is saved for it as compact rows, and the lookup. **Back to job results** is at the top with how many are left; **Next unresolved game** and **Done reviewing this game** stay pinned to the bottom of the dialog, and Next moves down the list.
- **Cleanup** (`LibraryCleanup.svelte`, `CleanupProposal.svelte`) says the run's state in words, compares Current and Proposed side by side, names what each finding is about (`lib/cleanup-labels.ts`), and keeps the approve and apply bar pinned while the fixes scroll. Games are named, never shown as identifiers. The host picker appears only when there is more than one; the setup command sits behind **How to set it up**.

Both screens look again two seconds after work starts and every two seconds while it runs, and only every fifteen when nothing is happening (`wake` in `lib/library-jobs.ts`, `schedule` in `lib/workflow-runs.ts`). A screen that starts work must not wait for the idle interval to show it.

### Player window

While a game runs it owns the window (`.browser-player.playing`): the page is dark whatever the library's theme, and the game fills everything under one bar.

- **One bar.** Leaving, the game's name, the quick actions (Save state, Capture screenshot, Game view, Fullscreen) and the tools (Saves, Controls, Video, Core options, Details). Nothing else sits above or beside the game.
- **Tools open over the game's edge.** A tool is a drawer on the right that covers part of the picture; it never resizes the game. Pressing its button again, the close button or Escape puts it away. Tools stay mounted while closed, because saves in flight and option choices live in them.
- **Details is a tool.** Session details, runtime messages and "This browser" are in the Details tool while a game runs, and on the page before it starts. Nothing a person needs is below the game, because the game is as tall as the window.
- **Waiting says what it is waiting for.** The start-up covers the game area with one line that changes: "Getting the game… 43%", "Getting the emulator…", "Starting…" (`progress` in `player/controller.ts`).
- **Core options are listed at once**, with search. Choices fill in from a background read that never pauses the game.
- **Unsaved progress is never tucked away.** Its notice sits under the game, not inside a tool.
- **What the browser can do is asked in one place.** `lib/browser-features.ts` lists every optional ability (WebAssembly features, WebGPU, private file storage, WebHID, Web Serial, MIDI, wake lock, newer CSS) with the question that detects it. Components ask `browserFeatures().has(id)`; they never read the browser's name or probe `navigator` themselves. An emulator's needs are declared in `runtimeNeeds`, and the setup screen says which one is missing before Start. Add an ability there first, then use it.

### Settings

- **Activity** (`Audit.svelte`) is a list of sentences (`lib/audit-labels.ts`), who did it and when; the recorded code and identifiers are under **Details**. A refused sign-in is marked.
- **Libraries** never folds away a folder that belongs to no library.

Plugins, Emulators and Updates name things the way the owner would. A plugin's or a source's identifier sits under Details. A build that is named only by a commit is shown as "Nightly build from <date>" (`buildName` in `lib/server-updates.ts`), and an emulator's version is left out when it is only a commit. Update choices are sentences ("Ask me first", "Install automatically"), not modes. Settings has Sign out under Setup guide whenever someone is signed in. On Libraries the tick list of unassigned folders shows names only, because the table under it carries the paths.

### Game page

Opening a game is a step in the browser's history: Back returns to the list where it was, Forward reopens the game, and "Back to collection" goes the same way. Previous and Next (and the Left and Right arrow keys, when nothing is being typed in) move through the list the game was opened from; stepping replaces the history step, so one Back still returns to the list. Search matches a game's file name as well as its title, so typing a file type such as `chd` lists those files; each row shows its type beside the system.

Opening a game in a server folder shows `GameSource.svelte`: the front cover, the title, one line of facts (system, year, publisher, genre), then **Play**, **Download**, **Edit details**, and an icon-only refresh. The description sits under the actions and folds after four lines. Panels follow in a fixed order: **Artwork**, **Details**, **Files**, saved patches, **Manage**.

One matching controller is created for the page and shared with `MatchingPanel` (`controller` prop), so the cover, the details and the lookup never show different saved state.

- **Artwork** (`GameArtwork.svelte`) is a strip with one tile per kind of picture. A saved banner also runs across the top of the page. A tile opens the viewer; an empty tile (shown only to someone who may edit) opens the file chooser. The viewer steps through the saved pictures with arrow buttons or arrow keys and carries the icon buttons: download, replace, remove. Remove asks first, because the picture is not kept anywhere else. Every icon button has an `aria-label` and a `title`. On a mouse a small pencil appears on a tile for a direct replace; on touch the viewer's full-size buttons do it.
- **Details** (`GameDetails.svelte`) lists the saved fields and is absent when there are none. **Edit details** turns it into a form in place; every field is sent, so emptying one clears it.
- **Manage** holds the occasional tasks as disclosures, each with a name and one line saying what it does: look up details and artwork, other copies, convert a disc, organize the file. A new task goes here, not in the action row. Inside the lookup task the saved matches are one compact row each; the big cards are for the review flow in Library activity only.

Uploaded games use the same page through `GameItem.svelte`: the cover is the picture the collection shows for the game, the action row is **Play**, **Add a file**, **Rename**, and refresh, and **Pictures** lists the game's artwork and screenshot files with the same viewer (`components/PictureViewer.svelte`, shared by both pages). The file table follows without its own Play section, and **Manage** holds other copies and **Move to trash**. Moving a picture or the game to the trash has no confirmation because the trash keeps it for 30 days. A single save or other file opened from the Saves, Media, or System files tabs keeps the plain file page.

A game stays open when a rename or new details sort it somewhere else in the collection. `lib/library-browser.ts` reads up to three batches further to find it, and otherwise keeps the open game as it was; its own page still checks that it exists and may be read. Both pages show the title that was just saved without waiting for the collection.

Existing `--ink`, `--ink-dim`, `--paper`, `--panel`, `--line`, `--accent`, and `--warn` are compatibility aliases. Prefer semantic tokens in new components. Apply theme overrides to `:root`; scoped overrides can directly use the compatibility names where old components need them.

Touch controls are at least 2.75rem (44px at the default font size). `.compact-controls` opts a subtree into 2.25rem mouse controls only on wide screens with a fine pointer, hover, and no coarse pointer. Settings and FolderPicker use this class; collection controls retain the same density through their shared selectors. Never shrink coarse-pointer targets to fit a layout. `label.check` gives a checkbox its full labelled hit area.

## Shared pieces

- `components/Tabs.svelte`: horizontal, automatically activated tabs. Supply `tabs`, `selected`, `onchange`, `label`, a page-unique `idPrefix`, and `panelId`. The caller supplies the panel and its `aria-labelledby`. Arrow keys wrap; Home/End select the first/last item; only the selected tab enters the Tab sequence. Storage and `CategoryTabs` use it, preserving their accessible labels and IDs.
- `components/FormField.svelte`: one native input, select, or textarea with a visible label and optional help. The child snippet receives `id` and `aria-describedby`; spread these onto the native control to link its name and description. Keep `required`, `disabled`, `type`, autocomplete, and bindings on that control. Generated IDs are unique per instance; an explicit `id` preserves an existing public association. Help text is a description and does not change the accessible name.
- `components/InlineNotice.svelte`: short text-only feedback. Default `info` is quiet supporting text; `status` announces loading or completion politely; `error` uses an alert. It never moves focus. Keep retry buttons outside the notice and choose announcements deliberately so empty states do not create live-region noise.
- `components/MatchMetadata.svelte`: matching cards show familiar game details first. Technical identifiers, catalog references, and verification provenance stay under the native “Match evidence” disclosure, with descriptive labels. Preserve the “Matches saved game details” label for candidates anchored to a saved selection.
- `.settings-form` and `.settings-fields`: forms place actions below a wrapping group of fields. Fieldsets keep their native disabled behavior; controls stay bounded and stretch to fit narrow screens. Labels, help, feedback surfaces, and spacing use the shared tokens.
- `.ui-navigation`: native navigation buttons with transparent resting surfaces and shared `aria-current` selection. Used by Settings and folder Places. Use the right `aria-current` value for the context (`page` or `location`). Component CSS owns orientation and wrapping.
- `.ui-actions`: wrapping action row aligned to the end, with shared spacing. FolderPicker stretches its buttons on phones. Keep main actions in normal document order; use the existing `primary` class sparingly.
- Matching screens use `.matching-page` for regular vertical rhythm, `.matching-primary-actions` for the main action pair, `.matching-actions` for related controls, `.matching-fields` and `.matching-field` for consistent forms, and `.matching-check` for full-size checkbox rows. Use one `.matching-options-disclosure` per screen for secondary provider and matching settings; keep current job progress directly below the activity picker. Less frequent library actions use a compact disclosure. `.matching-result-list` and `.matching-card-grid` style repeated matches. These patterns use semantic theme tokens and retain native controls.

Use FormField without replacing native form behavior:

```svelte
<FormField label="Device name" help="Choose a name you’ll recognize.">
  {#snippet children(attributes)}
    <input {...attributes} bind:value={name} required disabled={working} />
  {/snippet}
</FormField>
```

Keep component-specific grids and scroll regions in scoped CSS. Use tokens for their spacing, surfaces, radii, and text. Preserve native disabled behavior, visible keyboard focus, reduced-motion preferences, and existing accessible names.

## Migration and checks

This first pass audited global styles, Settings, Storage, Locations, FolderPicker, and existing tabs. It removes repeated palette declarations, duplicated tab keyboard handlers, local folder-picker control sizing, and redundant Locations overflow styles. FolderPicker and Storage demonstrate semantic tokens; Settings uses shared navigation. Other feature-specific surfaces and bespoke dimensions remain for later small batches. No framework or dependency was added.

`test/browser/design-language.spec.ts` uses ephemeral generated fixtures at desktop and touch-phone sizes. It checks tab navigation, 36px/44px density, bounded overflow, theme propagation, Escape focus return, and absence of writes while browsing. Its screenshots record the representative picker at both sizes. Run the web Svelte check and production build before this focused browser check. Existing folder tests cover registration, failures, and write-target safety.

The second pass applies FormField to Devices and Access, and InlineNotice to Devices, Access, and storage feedback. It keeps all existing form labels, button actions, defaults, validation attributes, and request logic. Helper text now has explicit control associations; long controls shrink within the page. Both components use global classes in `app.css`, so theme and spacing changes reach every instance.

The matching pass applies the same tokens to LibraryJobs, BulkMatching, MatchingPanel, and MatchingProviders. Main actions and review navigation use consistent wrapping action rows, and result lists end in the shared `ListMore` foot; provider controls and matching guidance share one options disclosure per screen; repeated candidate and job rows share spacing and borders. LibraryJobs keeps active progress above advanced options, with result counts as the filter for the list below them. Candidate cards show publisher, developer, year, genre, region, language, and description first; technical identifiers and catalog references remain available under Match evidence. Keep status announcements and native checkbox/select semantics in place when extending these screens. The matching browser test checks primary actions, phone touch targets, visible job progress, narrow-viewport overflow, and progressive evidence disclosure.

`test/browser/settings-forms.spec.ts` checks accessible names/descriptions, label-click focus, native required validation before requests, disabled controls during a delayed failure, preserved values afterward, conditional fields, Tab order, and viewport overflow on desktop and touch-phone sizes. It captures Devices and Access using generated fixtures without issuing credentials or saving policy changes. Existing Devices and owner Access browser tests cover actual create/revoke and membership/password/policy behavior.


## Emulator settings

`EmulatorSettings.svelte` uses the shared tabs, fields, notices, and tokens. Installed and Available stay separate; unsupported catalog entries explain why installation is unavailable. Operator installations are read-only. Managed entries expose enable/disable, default selection, and confirmed removal. The native, single-file picker accepts `.ecsplayer`; choosing a file only stages it. Installation starts when the owner clicks an install button. There is no URL input or background installation.

The controller in `lib/emulator-settings.ts` serializes changes and trusts returned management state. It clears owner details on authorization failure, explains owner sign-in for local-trust refusals, and shows an unavailable API explicitly rather than inventing an empty catalog. An uncertain mutation or failed catalog-refresh callback requires a read refresh before another change. The `onplayerschange` SettingsShell callback refreshes browser-play choices; running games retain their loaded emulator. After installation/removal, focus moves to the Installed tab when the initiating control is gone; cancelling removal returns focus to its button.

Focused controller tests cover guards, concurrency, interrupted results, callback retry, authorization, and disposal. Browser tests cover desktop/touch layouts, tab keys, read-only operator entries, unavailable reasons, explicit actions, removal focus, native file selection, and owner visibility. A generated package also installs through the real ephemeral server and proves enable/default/remove updates browser-play choices without an emulator or ROM download.


Managed Parallel DC cards expose the native `Add system file` picker for user-supplied Atomiswave `awbios.zip` firmware. Selection stages one ZIP; only `Install system file` uploads or replaces it. Current declared asset names and sizes stay visible, including on read-only operator cards. The controller allows only this known filename on managed IDs ending `parallel-dc`, canonicalizes filename case, and rejects files below the 22-byte ZIP minimum or over 32 MiB before a request. The server remains authoritative for archive contents and compatibility. The UI explains that files are shared with players on the server, that no firmware is downloaded for the user, and that games and saves stay unchanged. Focused tests use generated bytes and make no firmware-compatibility claim.
