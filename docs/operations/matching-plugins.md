# Matching providers and managers

The owner can open a server-folder game and use **Metadata, artwork & patches**.
Click **Find matches** for local suggestions, or enable **Include online providers**
for Libretro. Results are previews in this first pass: they do not rename ROMs,
apply patches, change system identifiers, or save metadata automatically.

Local matching finds exact filename stems beside a game, or in its `artwork`,
`boxart`, `covers`, `patches`, and `metadata` subfolders. JSON sidecars may contain
string fields `title`, `description`, `developer`, `publisher`, `year`, `genre`,
and `region`. PNG, JPEG and WebP artwork is previewed through an authenticated,
size-limited endpoint. SVG is not accepted. A different region/edition remains a
different filename. Invalid sidecars do not prevent other providers from working.

BPS and UPS files supply base size and CRC only after the patch's own CRC passes.
IPS has no embedded base checksum and remains an unverified filename association.
A user can explicitly hash a local, single ROM up to 64 MiB; matching base CRC and
size upgrades the patch association. A different base CRC/size rejects the patch. A matching checksum can associate a differently named patch in the same folder or its `patches` subfolder.
No patch is ever applied by matching. Archive and disc-container hashes are not
used as if they identified an inner ROM; those entries use filename suggestions.

The Libretro provider downloads public no-intro/redump DAT catalogs from the
[Libretro database](https://github.com/libretro/libretro-database). Its initial
system mapping covers Jaguar/Jaguar CD, NES, SNES, Game Boy/Color/Advance, N64,
Genesis, Master System, Game Gear, PlayStation, Saturn, and Dreamcast. Missing
catalogs yield no suggestions. It compares checksum plus size first, then exact
edition filenames. Thumbnail candidates use the
[Libretro thumbnails](https://github.com/libretro-thumbnails/libretro-thumbnails)
box-art names; existence is checked only when Preview is requested, so some art
may be unavailable. Lookup sends no ROM bytes, local paths, or server credentials
to Libretro. A thumbnail request reveals the selected public title to its host.

## Plugin contract

This extends the existing `ecs.plugin/1` engine with two app-independent kinds.
Providers declare capabilities: `rom`, `metadata`, `artwork`, `patch`, `cheats`.
Managers declare which provider IDs they coordinate. Built-in local and Libretro
providers use the same matching interface as installed JavaScript providers. The
current default manager ranks checksum matches before local associations and
filename hints, preserves provider attribution, and reports provider failures
without discarding healthy results. The fast scan-time system detector remains
available before a matching job; a provider's ROM/system suggestion is a preview.
A cheats capability is supported, but no bundled cheats service is enabled.

Install trusted provider/manager folders on the server, then run:

```sh
ecs serve --data /path/to/data --matching-plugins /path/to/plugins
ecs-plugins providers --plugins /path/to/plugins
ecs-plugins match --plugins /path/to/plugins --input /path/to/facts.json
# Explicitly allow providers that declare network access:
ecs-plugins match --plugins /path/to/plugins --input /path/to/facts.json --online
```

A provider's `plugin.json`:

```json
{
  "id": "example.metadata", "name": "Example metadata", "version": "1.0.0",
  "kind": "provider", "engine": "ecs.plugin/1", "entry": "provider.mjs",
  "provider": { "capabilities": ["metadata"], "network": false }
}
```

Its entry exports `{ search(input, signal) }`. The input contains a basename,
system identifier (or null), optional size/MD5/CRC, an explicit `online` boolean,
and bounded companion facts. It has no data-directory path or server token.
Return up to 100 candidates with `id`, `kind`, `title`, `confidence` (`checksum`,
`local`, `name`), and string-valued `metadata`. A candidate may reference a known
companion `fileId` or a credential-free HTTPS `url`. The web API refuses unknown
companion IDs. Generic remote artwork plugins can report URLs; the first web
preview implementation fetches remote pixels only from the built-in Libretro
thumbnail provider, plus authorized local companions.

A manager declares `"manager": {"providers": ["example.metadata"]}` and exports
`{ selectProviders(input, availableProviders) }`, returning its chosen provider
IDs. It can choose/order providers within that declared list. Request-level
provider selection and online opt-in still restrict the result. Manager plugins
are orchestration policies, not database or file managers.

Installed modules execute only in a separate Node child process, with a stripped
environment, a memory limit, bounded IPC, per-provider deadlines and a hard outer
deadline. Owner lookups and remote artwork share two active worker slots; closing
the request cancels the worker. Preview requests expire in fifteen minutes.
**This is process isolation, not an OS sandbox.** Installed JavaScript is trusted
operator code with that OS user's filesystem/network permissions. A manifest's
network declaration controls normal invocation, not a hostile module's syscalls.
Do not put secrets in manifests. Provider-specific credential configuration and
persistent acceptance of selected matches are follow-up work.
