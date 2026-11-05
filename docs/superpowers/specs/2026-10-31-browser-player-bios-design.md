# Server-managed browser BIOS files

Status: proposed design, awaiting approval. On 2026-10-31 the user chose server-managed BIOS files: upload once for Mac and iPhone. This authorizes this design, not product implementation. All automated browser work must remain headless and silent, with no visible tabs, foreground apps, native pickers or headed fallback.

Builder check completed: one fresh read-only reviewer reported “nothing important left.” No product code, dependencies, browser or emulator launches were used for design work. Unrelated AI-library documents remain untouched.

## Intent and boundaries

Owners can see which firmware a supported installed browser core can use, upload their own files, replace or remove them, and understand what a missing file means before starting a game. Firmware lives on the content server, so another admitted device needs no separate browser vault. Keep the Svelte player, opaque runtime sandbox and existing emulator-resource download mechanism.

This is a coordinated protocol/server/client/web change. It extends the managed player installation machinery; it does not put firmware into the game library or introduce another database/storage service. A file belongs to a managed core installation, rather than becoming a global cross-core vault. Upload once means once for that installation, accessible from Mac and iPhone; unrelated cores may need separate installation of a compatible file.

No firmware downloads, shipped BIOS bytes, arbitrary file manager, generic archive extraction, directory uploads, browser-local vault, new core builds, new content extensions or native/Swift UI work. Do not imply FDS support in the current NES-only profile, external BIOS support in the current BIOS-free Jaguar build, or availability of Atari 5200 merely because firmware exists upstream.

## Approaches and decisions

1. **Server-managed firmware, selected by the user.** Extend the existing owner-only system-file installer and atomic profile resource staging. One upload serves admitted devices and survives browser storage clearing. Files are shared emulator resources, not personal library assets.
2. **Browser-local vault, deferred.** Avoids server sharing but requires repeated setup on each browser, Safari storage handling and additional account/window lifetime rules.
3. **Both stores, deferred.** Adds precedence, duplicate files and ownership choices before the central management experience is established.

The builder calls below are proposals made for this design: a small curated build policy, strict raw-file identification, individual upload/replace/remove actions, and per-installation storage. They are not earlier user requirements.

## Owner experience

Extend Settings > Emulators > each installed emulator's system-file area into **BIOS & system files**. Show the installed build, supported firmware slots, canonical filename, affected system, requirement and state. Keep existing support assets visible separately; their presence never makes them removable BIOS files.

Suggested row content:

| Example | Requirement | State / action |
| --- | --- | --- |
| PlayStation BIOS | Optional; HLE available | Missing / Upload BIOS |
| scph5501.bin | Optional PlayStation variant | Recognized / Replace / Remove |
| awbios.zip | Required for Atomiswave | Missing / Upload archive |
| Uncatalogued build | Requirements unknown | Firmware management unavailable for this build |

Use ordinary file inputs that work with iPhone Files. Do not depend on File System Access, directory pickers or drag/drop. File selection only prepares a named file; an explicit Upload/Replace action performs the change and shows its size and target core. Validate cheap size/extension constraints before submission; the server determines identity and canonical filename. The selected slot determines the API target, never the uploaded filename. A renamed valid raw BIOS may be accepted and stored under its verified canonical name; wrong content with a familiar filename is rejected.

For the initial raw PlayStation set, each row is a particular recognized variant, not a user-assigned region override. Selecting a different recognized variant for that row reports the detected variant and asks the owner to use its matching row; it does not silently overwrite another slot. Batch multi-file upload is deferred.

Installed rows show file size, identification level and an expandable checksum/build explanation. Use **Recognized BIOS** only when content identity matches the allowlist. Existing Atomiswave structural validation is labeled **Archive structure checked**, never checksum-verified firmware. SHA256 transport integrity is a separate property.

Before the first upload and beside the list, state: **Stored on this server and shared with admitted players. Changes apply the next time a game starts.** This follows the existing shared system-file policy. Do not silently apply library BIOS guest ACLs or imply the bytes remain owner-private. Owner bearer authentication is required for every mutation; other admitted users can see applicable readiness but cannot manage files. Existing operator-installed profiles remain read-only with an operator-managed explanation.

Remove opens a small confirmation naming the file, core and consequence (HLE fallback versus required system unavailable). Replacement already identifies its target and needs no second confirmation. Failed validation or replacement leaves the prior file intact. In-flight mutation disables conflicting actions. Announce completion/errors accessibly and preserve existing uncertain-result refresh behavior: a lost response requires refresh before another change, not an automatic repeat.

Use stacked rows and 44px controls on iPhone, labels in addition to color, wrapping filenames, keyboard operability, and status announcements. No horizontal scrolling requirement. Uploading does not open/start an emulator or request audio.

## Initial supported firmware and evidence

Firmware requirements bind to an admitted **build**, not just a system or core ID. A server-owned policy module maps a profile's ID and pinned loader/wasm identity to known slots; buildVersion is explanatory text, not the sole authority. Match pinned catalog/build artifacts using recorded hashes. Unsupported or changed binaries yield unknown requirements and no new firmware mutation privilege. No remote metadata service or newly trusted manifest-supplied filesystem paths.

Initial new raw-file management targets the existing PCSX ReARMed build, which supports real BIOS with HLE fallback. Start with the documented 512 KiB scph5500.bin, scph5501.bin and scph5502.bin identities, after checking the exact pinned core source's lookup order and filenames. The implementation must record primary-source references, hashes and canonical names in the curated policy. Do not infer new variants from filenames or implement arbitrary scph-prefix uploads. Known MD5 identities may identify these historical files; compute MD5 on the server and also retain SHA256 for resource integrity. No browser MD5 implementation is needed.

Preserve the existing managed parallel-dc awbios.zip installation and its compatibility boundary, including its legacy admission rules. Its existing ZIP structure check remains a distinct validation level; this batch does not claim the archive's decompressed payload is authenticated. Its canonical runtime destination remains dc/awbios.zip. Do not silently extend the legacy ID-based exception to other Dreamcast/arcade BIOSes or unknown builds. The existing file remains manageable after upgrade, including removal, even if its build lacks newly pinned metadata; label that legacy support explicitly.

Other cores receive an honest unknown/build-limited explanation unless the policy can substantiate their requirements. Do not label unknown firmware requirements as “BIOS not needed.” ProSystem and other raw firmware sets can be added later using the same policy without expanding this batch's acceptance scope.

Installing PlayStation BIOS does not override the existing core option **Auto / HLE**. Explain that Auto permits the core to select firmware and HLE forces emulation. If the current options can be read reliably, show the selected mode; otherwise show the explanatory text rather than claiming which BIOS ran. Multiple installed variants follow the pinned core's own selection order; no new region/BIOS-selection option is invented.

## Protocol and model

Extend OpenAPI additively. Add optional, bounded firmware metadata to WebPlayerDescriptor; absence means unknown/older server. A versioned firmware policy object contains bounded slots with stable ID, display label, canonical flat asset name, relevant system IDs, required/optional status, validation level, canonical runtime destination and identity/size descriptions. A slot may represent an alternative within a group; one installed valid alternative satisfies that group's requirement. PlayStation variants form an optional group; Atomiswave has one required slot. Define caps no larger than the existing 16-resource envelope, bounded text/checksum arrays and no unbounded descriptive strings.

Installed state is derived from matching profile assets plus server validation, rather than trusting a client-provided boolean. Metadata must distinguish an existing but unrecognized asset from a verified supported slot. Normal public profile responses expose applicable requirements for preflight. The owner management view can additionally expose canonical management actions for profiles whose playable systems are currently filtered out. Avoid a new public owner-management endpoint.

Generalize PUT /api/v1/player/management/{id}/system/{name} from the single awbios.zip enum to bounded canonical names recognized by server policy. Keep its existing operation ID, MIME and response shape. Add owner-only DELETE at that same path returning refreshed PlayerManagement. Unknown names, builds or non-firmware assets cannot be mutated through either operation. Operator profiles reject mutation. Do not allow a user-supplied relative path or URL.

Regenerate TypeScript/Swift models and clients from OpenAPI, update the intentional protocol surface and run drift checks. Add app-neutral TypeScript client support for deletion and current metadata. No migration is needed. Optional response metadata preserves older-server clients; the updated web UI degrades to the old Atomiswave behavior or read-only unknown text when metadata is absent. Do not call an unavailable DELETE endpoint on an older server.

## Server storage and lifecycle

Reuse PlayerManager's serialization and staged manifest/resource replacement, profile revalidation, atomic rename, persist/publish and rollback. Generalize the existing mutation helper for install/replace/remove without rewriting unrelated assets. Canonical upload names map to safe generated storage filenames; filenames/extensions from the user's device are never filesystem paths. Delete only policy-recognized firmware; never loader, wasm or support resources.

Keep existing 32 MiB request/resource and 16-asset/32 MiB combined limits and the global snapshot cap. Validate raw-file length and known identity before any destructive operation; keep Atomiswave's bounded structural ZIP checks without extraction. Validate a candidate staged profile fully before activation. On any failed replace/remove, restore the old installed profile and published in-memory snapshot; cleanup staging without deleting the last usable copy. Test persistence/reload failure as well as ordinary validation failures.

Initial installation-package firmware assets are checked by the same policy before being reported as ready. Existing unrecognized files remain preserved and visible; they cannot satisfy new raw-BIOS readiness or be removed as arbitrary files. A recognized firmware slot may be replaced with valid bytes, including repair of a previously unrecognized file under that slot name. A recognized slot name may be removed without claiming its contents are valid. Preserve the existing awbios compatibility exception.

Profiles and file bytes remain in-memory launch snapshots. An ongoing session keeps its captured resources even after an owner replaces/removes them; the next launch uses a fresh descriptor and hashes. No live filesystem mutation or restart. Disabled managed profiles can be prepared; operator installations stay read-only. Firmware is part of its managed installation and survives normal server restart. Uninstalling that emulator removes its managed firmware too; explain this in the existing emulator uninstall confirmation. Reinstall/core upgrades do not silently carry files across unsupported builds; use existing install semantics rather than adding an update mechanism.

Continue filtering Atomiswave from the public playable systems when its required archive is absent. Management still shows the installed core's Atomiswave requirement and Upload action. The player must explain missing compatible support without pretending an unavailable profile can Start. Do not broaden profile publication or legacy client behavior merely to show a BIOS row.

## Player readiness and staging

Before Start, show requirements for the selected profile/system: **Ready**, **Optional BIOS missing — HLE fallback**, **Required file missing**, or **Requirements unknown for this build**. Firmware presence is not a guarantee a game runs. Unknown optional metadata does not newly block previously playable cores; existing profile/system admission remains authoritative. Missing required slots for the selected system block startup with owner Settings guidance or a request to the owner. Do not gate Dreamcast on an Atomiswave-only requirement.

Re-evaluate the fresh profile and all applicable groups inside prepare/start before importing loader code or callMain, not only in the Svelte button state. An asset fetch/hash mismatch after a server mutation must fail safely with refresh/retry guidance; never combine stale metadata with unverified bytes. Each new game window performs the same preflight through its fresh profile fetch; no BIOS bytes or authority pass in its URL.

Controller startup continues verifying every resource's SHA256 and length. For known firmware slots, stage at the policy's canonical destination under /ecs/system. The browser validates this bounded relative destination (no absolute, empty, dot, dot-dot, backslash or encoded path segments); create only approved subdirectories. Preserve flat support-resource staging and the existing parallel-dc dc/awbios.zip alias. Never expose a generic guest filesystem write RPC or relax sandbox/CSP policy. The host assembles the approved files before core startup using the existing path.

Readiness and management status derive from the same versioned server metadata; small pure web helpers may interpret the API contract, but must not maintain a second independently authored BIOS catalogue. Reopening management/refetching profiles updates readiness. Do not change current game/save selection, pending captures or input ownership merely because firmware changes.

## Validation and acceptance

Use generated bytes, fake small profiles and injected test policy identities. Never commit or retrieve actual BIOS bytes for tests. Production policy rejects these fake bytes; fixtures do not add a test bypass to a real server. Test checksum decisions independently with known original input and exercise real production filename/size policy rejection.

Focused server tests: owner/non-owner/guest mutation boundaries; raw wrong size/hash and disguised filenames; unsupported build/name/operator profile; preserved legacy Atomiswave behavior; replacement/deletion; support asset protection; limits/path rejection; rollback and restart; required-system publication filtering; stable active-session snapshot. Include one proportionate review of auth/storage/protocol risk, not a fleet.

Client/web tests: optional metadata/older-server fallback; explicit upload action and duplicate suppression; readiness scoped to system/group; Auto/HLE messaging; retry/uncertain results; pre-import gating and canonical staging; stale profile/resource mismatch. Generated silent browser fixtures cover owner upload/replace/remove, non-owner read-only view, missing/optional status and narrow iPhone layout in headless Chromium and desktop/iPhone WebKit. Chromium audio stays muted; fixtures use no audio/emulator APIs. Do not launch real cores, visible Safari, OS file dialogs or speaker-capable audio for this batch. Use Playwright file injection rather than opening a native chooser.

Run affected server/client/web tests, relevant Svelte/typechecks/build, generation/drift/surface checks, package boundaries and secret/fixture scan. No full monorepo/native/Swift build matrix. Record that actual iPhone Files selection and hardware Safari core behavior remain manual acceptance gaps; headless WebKit is useful coverage, not physical-device proof.

## Builder discretion and sources

The builder may settle component/helper names, exact optional schema field names and error wording within these bounded semantics. Verify pinned PCSX source and module identity before admitting raw files; if that evidence contradicts the proposed three variants or cannot be established, report it and narrow the accepted set explicitly rather than inventing support. No decision to expand supported cores, sharing policy, arbitrary uploads or release-hardening scope is delegated.

See [research](../../operations/browser-player-bios-research-2026-10-31.md) and the primary [PCSX ReARMed documentation](https://docs.libretro.com/library/pcsx_rearmed/), [firmware guide](https://docs.libretro.com/library/bios/), and [core metadata guidance](https://docs.libretro.com/meta/core-template/). Upstream Flycast/FCEUmm firmware lists do not independently establish ECS browser-build support. No browser or emulator was launched to produce this design.
