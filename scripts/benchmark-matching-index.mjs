/** Opt-in generated 100k-file catalog benchmark. Never reads ROM files or an operator catalog. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { CatalogDatabase } from '../packages/database/dist/src/index.js';
import { companionSelection } from '../packages/database/dist/src/source-companions.js';

const count = Number(process.argv[2] ?? 100000);
if (!Number.isSafeInteger(count) || count < 1 || count > 250000)
  throw new Error('Choose 1–250000 generated files');
const directory = await mkdtemp(join(tmpdir(), 'ecs-match-benchmark-'));
let catalog;
try {
  const filename = join(directory, 'library.sqlite');
  catalog = new CatalogDatabase(filename);
  const owner = catalog.createUser({
    username: 'generated-owner',
    passwordHash: 'generated-only',
    actorId: 'benchmark',
  });
  const library = catalog.createLibrary(owner.id, 'Generated benchmark');
  const root = catalog.createContentRoot({
    path: join(directory, 'generated'),
    label: 'Generated',
    libraryId: library.id,
    actorId: owner.id,
  });
  const files = Array.from({ length: count }, (_, i) => ({
    relativePath: `Games/Game-${i}.nes`,
    displayName: `Game-${i}.nes`,
    size: 1,
    blocks: 1,
    kind: 'rom',
    systemId: 'com.provenance.nes',
    availability: 'local',
  }));
  for (let i = 0; i < count; i += 200)
    files.push({
      relativePath: `Games/artwork/Game-${i} front.png`,
      displayName: `Game-${i} front.png`,
      size: 1,
      blocks: 1,
      kind: 'artwork',
      systemId: 'com.provenance.nes',
      availability: 'local',
    });
  const start = performance.now();
  catalog.applyInspection({ rootId: root.id, actorId: owner.id, online: true, files });
  const indexingMs = performance.now() - start;
  const timings = [];
  let hits = 0;
  for (let i = 0; i < 1000; i++) {
    const before = performance.now();
    hits += catalog.matchingCompanions(root.id, `Games/Game-${i % count}.nes`, true).length;
    timings.push(performance.now() - before);
  }
  const inspect = new DatabaseSync(filename, { readOnly: true });
  const query = companionSelection(root.id, 'Games/Game-0.nes', true);
  const plans = inspect
    .prepare('EXPLAIN QUERY PLAN ' + query.sql)
    .all(...query.values)
    .map((row) => row.detail);
  inspect.close();
  timings.sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      {
        generatedRomFiles: count,
        generatedSidecars: files.length - count,
        indexingMs,
        lookups: 1000,
        totalLookupMs: timings.reduce((a, b) => a + b, 0),
        p95LookupMs: timings[949],
        lookupHits: hits,
        rssBytes: process.memoryUsage().rss,
        plans,
      },
      null,
      2,
    ),
  );
} finally {
  catalog?.close();
  await rm(directory, { recursive: true, force: true });
}
