# Browser BIOS management research — 2026-10-31

Research for the next feature batch; no product changes or browser/emulator launches. All future browser tests remain headless and silent, without foreground or OS-focus changes. Previous window batch is committed as 6b28593. Unrelated AI-library docs are preserved.

## Existing implementation

- Settings uses EmulatorSystemFiles.svelte + emulator-settings.ts. Its owner-only installer accepts only managed parallel-dc / awbios.zip, up to32MiB. The UI explicitly says these system files are shared with players on the server.
- The OpenAPI PUT /api/v1/player/management/{id}/system/{name} currently restricts name to awbios.zip. General management therefore needs an intentional additive contract change, generated TypeScript/Swift models/client drift and surface checks where applicable; this is not just a new file picker.
- PlayerManager.systemFile serializes a staged manifest/resource replacement and rollback. It currently validates an Atomiswave ZIP member name/size. Emulator assets are integrity-checked and bounded; the profile supports at most16 assets and32MiB total resource bytes. Management mutations are owner-only. Existing profile asset downloads require read permission and are shared as emulator resources, distinct from library BIOS/system_file grant rules.
- controller.ts configures system_directory=/ecs/system, stages every profile asset by name and adds the legacy dc/awbios.zip alias for parallel-dc. Assets have flat safe names; a generalized firmware model needs explicit canonical subdirectory destinations without accepting arbitrary filesystem paths.
- Profile publication currently omits Atomiswave from parallel-dc's advertised systems when awbios.zip is missing. A general readiness UI should distinguish required-for-selected-system, optional/HLE fallback, unknown metadata and unsupported build features; it must revalidate immediately before code import/start.
- Ordinary library files already have bios/system_file kinds and restricted-guest sharing rules, but are not a cross-core firmware manager. Reusing them must not silently change ownership, guest access or core-resource sharing semantics.

## Core/build evidence

- [Libretro firmware guidance](https://docs.libretro.com/library/bios/) and the [core template](https://docs.libretro.com/meta/core-template/) describe filenames, optional/required status and MD5 identities in the frontend system directory; they also warn info metadata can differ from actual core behavior.
- [PCSX ReARMed](https://docs.libretro.com/library/pcsx_rearmed/) supports user-provided BIOS files with HLE fallback. Our pinned build script explicitly retains that fallback. Candidate for initial raw-BIOS management without a new core build, subject to verifying its exact metadata/staging.
- [Flycast](https://docs.libretro.com/library/flycast/) documents dc/ subdirectory placement and several conditional arcade firmware choices. That upstream list is not proof every corresponding ECS browser profile is supported. Existing parallel-dc Atomiswave behavior must be preserved.
- [FCEUmm](https://docs.libretro.com/library/fceumm/) documents disksys.rom for FDS, but the current verified ECS profile is NES-cartridge-only. Uploading an FDS BIOS must not imply that .fds admission or browser acceptance has been added.
- scripts/browser-core/virtualjaguar-bios-free.mjs deliberately removes external/embedded firmware staging for the current Jaguar HLE profile. Do not advertise a working real-BIOS option for it.
- ProSystem's build describes an optional BIOS, while Atari5200 is unavailable pending an appropriate build and staging. Names and requirements need to bind to admitted builds, not only system identifiers.

## Selected direction

Recommended: centrally managed, user-provided firmware with owner-only installation/replacement/removal, installed-build requirement metadata and player readiness before Start. Use normal file input for iPhone Files and optional Mac drag/drop; no dependence on directory-picker APIs. Preserve existing files on a failed or incorrect replacement. Apply changes on a fresh launch; do not rewrite a running core's filesystem. Never fetch firmware automatically or commit firmware test data.

On 2026-10-31 the user selected server-managed BIOS files, uploaded once for Mac and iPhone, and authorized writing the design. Browser-local storage and a combined model are deferred. See the [proposed design](../superpowers/specs/2026-10-31-browser-player-bios-design.md). Product implementation awaits design approval; no browser or emulator has been launched.
