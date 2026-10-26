# An approachable game library

This product should help someone find a game and decide how to play it before asking them to understand a server, a ROM, matching, revisions, or storage roots. Both a casual teenager and a returning adult can succeed through the same visible controls. Experience and goals are the useful distinctions: someone joining another person's library; someone adding their own existing games; someone looking for a familiar title; someone transferring a game or save to an emulator.

## Evidence

Inspected live Chromium screenshots from the real web build using `apps/web/test/browser/fixture.ts`: generated game/file bytes, a temporary catalog, a random listening port, and no operator data. Desktop viewport 1280×720; phone 390×844. Before screenshots are temporary Playwright output `approachability-approachable-library-screen-review/{login,landing,empty,collection,detail,collection-mobile,detail-mobile}.png`. These are reproducible fixture outputs rather than committed product assets.

- **Joining a library:** sign-in is a compact row of username/password fields, then an equally prominent access-token button. Nothing explains whose credentials to use or what signing in unlocks. First-run setup points straight at `bootstrap.token` and a data directory. Use a clear stacked form, explain what the library does, and distinguish setup code from account password without concealing the required code.
- **Choosing a library / first empty library:** Home is primarily navigation rather than a destination. Empty shelf has six equally weighted management actions, all filters, a generic empty message, and disabled pagination. The message “explicit library-folder scan” assumes implementation knowledge. Give Home real library choices, a direct create action, and a short create→add→play/download path. Put Add games beside the empty state, with honest device-upload versus server-folder choices.
- **Finding a title:** on phone, six management buttons plus filters put the first game title around y=800. Every missing cover says “GA”, so the most prominent surface cannot distinguish any game. Keep game search visible, group management under Library tools, collapse optional phone filters into Filter & sort, and give missing covers a readable title and console label. Whole covers and title rows must be ordinary clickable controls. Preserve bounded paging and back/focus restoration.
- **Playing or transferring:** desktop Play is buried in the game file's Actions column behind BIOS and ROM terminology. Phone table squeezes filenames into two or three fragments and splits “Battery save” across lines. Surface a single supported Play action before file management; explain downloading for unsupported browser play; use plain file labels and stacked phone file rows. Never imply that every console supports browser play. Keep downloads and preserved-save semantics intact.
- **Connecting on desktop:** source review of `apps/tray/src/LibraryWindow.svelte` finds a persistent URL field and “Use local managed service” competing with library tasks. Default to the local library path and move remote address details behind a labelled connection disclosure. Show which library is selected and recoverable connection feedback. This was confirmed in the built desktop frontend served against the temporary fixture: the persistent form consumed about 120px above Home. The final collapsed connection summary uses about 64px. Native IPC was replaced only at its transport boundary in browser tests; this does not claim native OS-dialog or WebView validation.

## Implementation boundaries

Parent owns LibraryShell / LibraryBrowser, library and folder setup, and desktop connection composition. UX work owns app.css, CollectionToolbar, CollectionPage, ViewState, Files, and Login. No new dependency, remote artwork, proprietary game fixture, native rebuild, or change to authorization or stale-state handling.

1. Create an actual Home with visible library cards and a direct create action. Use a short plain-language setup path for no libraries. Give the collection one primary Add games action and expose file upload, folder upload, and choosing an existing server folder as labelled alternatives.
2. Reduce mobile overhead: search stays visible, Filter & sort is a real accessible disclosure, desktop controls remain available, active filters remain apparent and clearable. Preserve the existing explicit search submission and system-selection behavior.
3. Make the game surface readable: cover fallback includes title, all controls have 44px minimum height, selected/focus states are explicit, section headings use sentence case with readable type. Keep authentic artwork when available.
4. Put supported browser play before files. Single-file games get one unambiguous Play button. Multiple playable files keep their individual labelled Play actions. Unsupported/no-game-file states explain the next real action. File categories use Game / In-game save / Saved snapshot / Console firmware (BIOS). Downloads retain their exact file identities and permissions.
5. Clarify account entry: purpose, account-source help, vertically arranged input fields, clear busy text, safe setup-code entry, and a quieter but still accessible access-token alternative.

## Acceptance

- New player can select a library from Home and find a game without opening Settings or using right-click.
- Owner has an obvious Add games path from an empty library and can distinguish copying device files from using files already on the server computer.
- At 390px width, search and a first game are reachable without passing a block of advanced controls; expanding Filter & sort exposes the same controls as desktop.
- Missing covers distinguish titles; game/card and list targets remain labelled buttons and preserve focus on return.
- Supported generated NES detail exposes Play before file tabs. Unsupported detail gives download guidance and no false Play button.
- Phone filenames remain readable; every Download button still names the precise file to assistive technology.
- Sign-in, token access, restricted-reader behavior, 401/403 clearing, upload dialog lifetime, and download byte preservation continue passing focused browser tests.
- Web Svelte/type checks and build pass. Native distribution and Intel support are outside this usability batch.

## Verified after implementation

The combined 390×844 phone screen shows two complete game cards without scrolling: the first card starts around y=414 and ends around y=697, whereas the previous first title sat near y=800. Add games has clear priority, Library tools is optional, search stays visible, and Filter & sort exposes all former controls on request. The managed game detail now shows Play at y≈486 before file categories. Game-file downloads come first, filenames retain their full available row width, and console firmware cannot displace the main play action. Desktop Home shows named library choices below a compact selected-library connection summary; Change connection reveals the unchanged address/native-verification actions.

Reviewed screenshots are saved outside the repository under `/Users/jmattiello/.codex/visualizations/2026/10/26/01a17a15-2ab0-7602-94bc-8889b779488b/approachable-library/`: `desktop-home.png`, `phone-library.png`, `phone-game.png`, and `sign-in.png`. These contain only generated fixture titles and a temporary loopback address.

Validation for this UX slice: both web and tray Svelte checks report zero errors/warnings; both frontend builds pass; changed CSS/new browser tests pass Biome; 10 focused browser tests pass, covering the three new UX cases plus desktop sign-out/download, isolated player sign-in, native-picker cancellation, registration/scan counts, failed managed re-verification and context retirement across library-folder, library-editor, and upload-storage actions. An earlier 24-test library/access/filter run also passed before the parent header grouping; the parent owns the intentional navigation updates to the remaining web tests.

A proportionate review of the signed-out reconnect change in `lib/application.ts` found no substantive issue: queued revalidation remains coalesced and epoch-guarded, and explicit sign-out disables private discovery while allowing public connection recovery.
