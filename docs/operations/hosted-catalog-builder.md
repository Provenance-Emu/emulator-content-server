# Hosted catalog builder

The hosted catalog is a versioned set of bounded JSON shards. Metadata records are built from a pinned `libretro/libretro-database` commit; cheat and patch records contain commit-addressed upstream resource URLs and SHA-256 pins. The build does not include ROMs, cheat bytes, or patch bytes in the release assets. Separately pinned public DAT snapshots retain their own source notices and bounded metadata archives.

## Reproduce the checked-in source pin

The current source pin and selected DAT/system mappings are in [`scripts/catalog-sources.json`](../../scripts/catalog-sources.json). Use a sparse checkout outside the project tree:

```sh
git clone --filter=blob:none --no-checkout https://github.com/libretro/libretro-database.git /tmp/ecs-libretro-source
git -C /tmp/ecs-libretro-source sparse-checkout init --no-cone
node --input-type=module <<'NODE' | git -C /tmp/ecs-libretro-source sparse-checkout set --no-cone --stdin
import { readFileSync } from 'node:fs';
const c = JSON.parse(readFileSync('scripts/catalog-sources.json', 'utf8')).libretro;
const paths = [...c.metadataFiles.map(x => x.path), ...c.cheatFolders.map(x => x.path)];
process.stdout.write([...new Set(paths)].map(path => `/${path}\n`).join(''));
NODE
git -C /tmp/ecs-libretro-source checkout da577d2865c2b1b834b2d5f2fd1368fc5110a01c
pnpm exec tsc -p packages/plugins/tsconfig.json
node scripts/build-hosted-catalog.mjs \
  --source-root /tmp/ecs-libretro-source \
  --release catalog-2026.10.28.1 \
  --output dist-release/catalog-2026.10.28.1
```

The builder verifies the source checkout commit, parses every selected DAT through `parseLibretroDat`, splits each system/kind at the 16 MiB shard limit, validates all generated index/shard records, checks every upstream resource digest, and checks BPS source size/CRC before recording patch facts. It writes `index.json`, `*.json` shards, `SOURCES.md`, `EXCLUDED.json`, `SHA256SUMS.txt`, and a local `BUILD-SUMMARY.json`. Existing output files are not overwritten.

Run builder tests with:

```sh
node --disable-warning=ExperimentalWarning --test scripts/test-hosted-catalog-builder.test.mjs
```

## Release contents and rights

`SOURCES.md` records the commit, source URLs, licenses, and notices. The root libretro-database license is CC BY-SA 4.0, but its README identifies upstream No-Intro, Redump, TOSEC, GameTDB, MAME, and FBNeo sources. The catalog preserves those source labels and notices; review upstream terms before republishing derived data. Cheat files have mixed sources and their individual terms are not resolved here. Empty cheats, unsupported CHT syntax, and files exceeding the hosted 256 KiB resource limit are omitted and listed with path/size/reason in `EXCLUDED.json`.

The two BPS patch records are pointers to exact upstream raw commit URLs. Their BPS bytes are fetched only to verify the hash and embedded base size/CRC. Their maintainers' license files do not grant rights to the underlying game/translation or patch content; the builder therefore does not bundle or mirror them. The source-only pointers and license notices are included for provenance, and mirroring requires rights-holder clearance.

`catalogs.yml` is manual and only creates a workflow artifact. It does not publish a GitHub release or modify the host application's pin. Publishing the artifact and setting the application pin are separate, explicit release operations.

## Original Jaguar CD catalog snapshot

The Jaguar CD shard now uses the original Redump AJCD DAT rather than the smaller Libretro mirror. Its 40 complete release names retain unlicensed, alternate, demo, language and reissue tags. Only track 1 contributes catalog hashes; descriptor or later audio-track hashes are not substituted, and catalog assertions do not establish private byte verification.

`scripts/catalog-sources.json` pins both the compressed archive and decompressed DAT by exact size and SHA-256. The builder accepts a single bounded stored/DEFLATE ZIP entry, never extracts paths or resolves XML entities, and rejects changed archives, changed DATs and unexpected record counts. A mutable upstream update therefore requires a new explicit pin.

For an offline rebuild, download `redump-ajcd-20261023.zip` from the immutable catalog release into a snapshot folder and pass `--snapshot-root /path/to/snapshots` to the existing builder command. `SOURCE-RECEIPTS.json` and `SOURCES.md` preserve the exact source, date, pins and upstream notices. The separate Redump snapshot does not inherit the Libretro repository's license.

Jaguar CD artwork first checks its dedicated Libretro thumbnail repository. While that repository is absent, the matching plugin uses the commit-pinned Virtual Jaguar collection, with its original image paths, blob identities, TheGamesDB attribution and documented release caveats. Explicit audited aliases connect older thumbnail names to full Redump release names. Generic Blue Lightning covers and unverified Songbird reissue scans stay review-only; title screens and gameplay captures retain their own artwork roles.
