# ROM identification and artwork acceptance — 2026-10-28

The existing library was upgraded through schema 19 and processed using the shared server queue. Source files were read for bounded identification only; no game/BIOS/disc/save data was committed or redistributed. Detached production snapshots remain independent of later source builds.

## Existing imported library

| Coverage | Before this batch | Final |
| --- | ---: | ---: |
| Metadata selections | 42 | 420 |
| Front artwork selections | 83 | 176 |
| Sources indexed | 1,608 | 1,608 |
| Game entries processed | 918 | 918 |

The verified-identification pass added 163 metadata and 58 artwork selections in 26.359 seconds, with zero failed entries. The follow-up exact-name pass added 215 metadata and 35 artwork selections in 12.041 seconds, with zero failures. Its explicit `allowExactNames:true` policy is persisted; all 250 fallback selections retain name confidence and the `exact-name` evidence label.

Needs-review outcomes fell from 570 to 325. The final job has 334 unmatched outcomes. Optional artwork does not inflate conflicts after the primary choices are saved. These are measured local-library runs with the normal public-source cache, not a throughput guarantee for 100,000 remote discs.

| System | Metadata | Front artwork |
| --- | ---: | ---: |
| Dreamcast | 24 | 23 |
| Naomi | 169 | 20 |
| Naomi 2 | 14 | 1 |
| Atomiswave | 25 | 12 |
| Atari Jaguar | 158 | 120 |
| Atari Jaguar CD | 30 | 0 |

All 125 selections present before the identification batch and all 346 selections present before the fallback pass were checked byte for byte and preserved. The same 1,608 source identities/paths/sizes, two folder assignments, user and two sessions remained intact. SQLite integrity passed; 882 per-source identification fact records are cached. Private integrity-checked backups of schemas 18 and 19 were retained before upgrades. The running service is healthy with no queued/running work left.

The mounted web UI was also inspected against the actual service: it displays the completed 918-entry job, saved policy, 325 review outcomes, fallback control and cross-session job history. Existing desktop clients retain the front-only selection response; the new role controls are in the updated server web UI.

## Generated checks

- Raw/header/padding facts, actual modern 7zz and legacy 7z compatibility, actual chdman CD/DVD/GD logical slices, Dreamcast/PlayStation serial reads, neutral arcade serials and private diagnostic validation.
- Reader cancellation, SIGTERM resistance, joined exit, source replacement, one native reader per worker, oversized dictionaries/output, encrypted/solid/multiple-ROM archives and unsafe entries.
- Installed identifier plugins, bounded host IPC and whole native-process-group cancellation.
- Partial DAT/hash/serial reconciliation, contradictory hash/serial/system/release guards, actual-shape Naomi/Naomi2 title aliases and serial-suffix covers, opt-in exact-name policy and verified-proof priority.
- Role-specific persistence/migration, legacy client compatibility, PDF download attachment, primary artwork ACLs, shared queue cancellation/resume/review and equivalent legacy option normalization.
- Web typecheck/unit tests, browser saved-match recovery, role filters/front/back/disc/manual coexistence and PDF download, shared-job history and fallback controls. Protocol/client drift, package boundaries and fixture/secret scan passed.

Generated fixtures contain original synthetic bytes only. No live Windows native-reader acceptance or full 100,000-disc decoding run is claimed.

## Follow-ups

RVZ/CISO decoder plugins, unsupported legacy/patched CHD layouts, parent images, secondary-track filesystem address rebasing, nested/solid/multi-ROM archive handling and very large archive members remain explicit unsupported/review cases. Cartridge padding removal is format-justified; arbitrary trimming remains forbidden. Full logical CHD verification is not implied by a header digest.

Local hacks/translations have typed patch metadata and verified base support; automatic patch application and hosted patch feeds are separate work. Consolidated metadata/cheat/patch catalog assets and their updater are documented as a versioned, provenance-preserving direction, not published by this batch. No existing release installer bytes were replaced.
