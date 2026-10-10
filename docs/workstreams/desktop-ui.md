# Desktop and menu-bar UI

Build a client of the existing API. Do not add a second storage path.

## Owned paths

- `apps/web` or `apps/menubar` (new)
- `packages/client-ts`

## Behavior

- Login uses bearer tokens. If cookies are introduced, add CSRF protection in the same change.
- Show libraries, items, upload progress, guest grants, and audit for the owner.
- Menu-bar status reflects `ecs serve` health and discovery. It does not embed the server.

## Acceptance

- The UI can upload a generated file and download a byte range through `ContentClient`.
- No game bytes are committed as fixtures.

## Non-goals

Emulation, JIT, and a custom sync protocol.
