# RomMClient

A Foundation-only Swift package for browsing and downloading from a RomM
instance. Each app saves successful logins in its Keychain and reconnects when
the library screen opens. Presentation and library imports also live in the apps.

The client uses `/api/platforms`, offset-paged `/api/roms`, ROM details, and
`/api/roms/{id}/content/{file_name}?file_ids={id}`. For grouped games it selects
each original file by ID and stages the files together with their relative paths.
Callers own the returned temporary directory and remove it after import.

The routes were checked against RomM 4.8.1 source and the 5.4.0 demo's OpenAPI
schema. The public demo smoke test exercises anonymous browse, search, paging, and
single-file and grouped downloads. Swift fixtures
cover bearer and Basic headers, HTTP opt-in, search, pagination, and single and
grouped downloads.

```sh
swift test --package-path clients/romm-swift
ROMM_DEMO_SMOKE=1 swift test --package-path clients/romm-swift --filter officialDemo
```

The repository's root Swift package exports both `RomMClient` and
`EmulatorContentClient`. Pin the repository once and add whichever products
the app uses. The nested manifest also supports testing this client in isolation.

Save sync is a later phase. It needs per-save baselines and conflict detection
when local and remote copies both change. A conflict should retain both copies
until the user chooses which version to keep or keeps both.
