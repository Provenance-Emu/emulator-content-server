# App adapters

Build clients in the Provenance, iCube, and iFly repositories. This server repository stays the contract owner.

## Owned paths

- Provenance: a new adapter target that depends on `clients/swift` or a vendored copy of the generated models.
- iCube and iFly: the same client, plus their existing library providers behind a thin mapper.
- This repository: only `docs/compatibility/provenance.md` if a field mapping was wrong.

## Behavior

- Discover `_pvcontent._tcp` or accept a manual base URL.
- Bootstrap and device-token login stay out of the game UI until a pairing screen exists. The first adapter may store a device token in the platform keychain.
- Map manifest `rom` files into the app importer. Leave BIOS files unimported unless the user turns on restricted sharing.
- Download with `Range`. If a ranged GET returns 200, delete the partial file and start over. That is the behavior in `ResumePlanner`.
- Send item updates with `If-Match: "rev-N"` and upload completion with `baseRevision`.

## Acceptance

- A fixture library created by `ecs serve` is listed in one app.
- A ranged read returns the same bytes as a local file.
- A guest token cannot download a BIOS asset.
- No Realm, Dolphin, or CloudKit types are added to this server repository.

## Non-goals

WebDAV, directory scanning, and JIT.
