import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { playerCatalog, type TrustedPlayer } from '../src/player-catalog.js';
import {
  exportPlayerCatalogSnapshot,
  loadPlayerCatalogSnapshot,
  parsePlayerCatalogSnapshot,
} from '../src/player-catalog-file.js';
import { catalogJson, createPlayerCatalogSnapshot } from '../src/player-catalog-snapshot.js';
import { upstreamFixture } from './player-cache-fixture.js';

function pinned(entries: unknown[], schemaVersion = 1) {
  const payload = { schemaVersion, entries };
  return { ...payload, id: createHash('sha256').update(catalogJson(payload)).digest('hex') };
}

test('the complete bundled catalog round-trips as a detached, immutable pinned snapshot', () => {
  const original = createPlayerCatalogSnapshot(playerCatalog);
  const raw = JSON.parse(JSON.stringify(original));
  const parsed = parsePlayerCatalogSnapshot(raw, original.id);
  assert.deepEqual(parsed, original);
  raw.entries[0].name = 'changed';
  assert.notEqual(parsed.entries[0]?.name, 'changed');
  assert.equal(Object.isFrozen(parsed.entries), true);
});

test('a matching self-declared hash does not override the operator expected ID', () => {
  const a = createPlayerCatalogSnapshot([upstreamFixture().entry]);
  const b = createPlayerCatalogSnapshot([upstreamFixture(2).entry]);
  assert.throws(() => parsePlayerCatalogSnapshot(b, a.id), /snapshot/i);
  assert.throws(() => parsePlayerCatalogSnapshot(a, '../not-a-pin'), /snapshot/i);
});

const malformed: Record<string, (entry: TrustedPlayer) => void> = {
  'unknown entry fields': (entry) => Object.assign(entry, { ignored: true }),
  'invalid public fields': (entry) => Object.assign(entry, { available: 'yes' }),
  'invalid system identifiers': (entry) => {
    entry.systems = ['../outside'];
  },
  'advertised system mismatch': (entry) => {
    entry.systems = ['com.provenance.nes'];
  },
  'missing provenance fields': (entry) =>
    Object.assign(entry, { provenance: { license: 'Generated' } }),
  'invalid provenance hash': (entry) => {
    entry.provenance = {
      sourceInfo: 'https://example.com/info',
      license: 'Generated',
      infoSha256: 'bad',
    };
  },
  'executable manifest': (entry) => {
    if (entry.upstream) entry.upstream.manifest.entry = 'execute.js';
  },
  'manifest identifier mismatch': (entry) => {
    if (entry.upstream) entry.upstream.manifest.id = 'org.example.other';
  },
  'mixed loader pin': (entry) => {
    const resource = entry.upstream?.resources[0];
    if (resource) resource.sha256 = '0'.repeat(64);
  },
  'zero resource size': (entry) => {
    const resource = entry.upstream?.resources[0];
    if (resource) resource.sizeBytes = 0;
  },
  'oversized resource': (entry) => {
    const resource = entry.upstream?.resources[1];
    if (resource) resource.sizeBytes = 65 * 1024 * 1024;
  },
  'untrusted upstream URL': (entry) => {
    const resource = entry.upstream?.resources[0];
    if (resource) resource.url = 'https://127.0.0.1/private';
  },
  'HTTP upstream URL': (entry) => {
    const resource = entry.upstream?.resources[0];
    if (resource) resource.url = 'http://web.libretro.com/generated_libretro.js';
  },
  'resource URL credentials': (entry) => {
    const resource = entry.upstream?.resources[0];
    if (resource) resource.url = 'https://secret@web.libretro.com/generated_libretro.js';
  },
  'resource field ignored': (entry) => {
    const resource = entry.upstream?.resources[0];
    if (resource) Object.assign(resource, { ignored: true });
  },
};
for (const [name, mutate] of Object.entries(malformed)) {
  test(`a pinned snapshot rejects ${name} before accepting any entry`, () => {
    const { entry } = upstreamFixture();
    mutate(entry);
    const raw = pinned([entry]);
    assert.throws(() => parsePlayerCatalogSnapshot(raw, raw.id), /snapshot/i);
  });
}

test('snapshot schema, duplicate identifiers and entry count are bounded', () => {
  const entry = upstreamFixture().entry;
  for (const raw of [pinned([entry], 2), pinned([entry, entry]), pinned(Array(65).fill(entry))]) {
    assert.throws(() => parsePlayerCatalogSnapshot(raw, raw.id), /snapshot/i);
  }
  const valid = pinned([entry]);
  assert.throws(
    () => parsePlayerCatalogSnapshot({ ...valid, unknown: true }, valid.id),
    /snapshot/i,
  );
});

test('snapshot files are bounded regular UTF-8 JSON and export never replaces an existing file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-player-catalog-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'catalog.json');
  const id = await exportPlayerCatalogSnapshot(file);
  const before = await readFile(file);
  assert.equal((await loadPlayerCatalogSnapshot(file, id)).id, id);
  await assert.rejects(exportPlayerCatalogSnapshot(file), { code: 'EEXIST' });
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readdir(directory), ['catalog.json']);
  const link = join(directory, 'link');
  await symlink(file, link);
  await assert.rejects(loadPlayerCatalogSnapshot(link, id), /snapshot/i);
  const folder = join(directory, 'folder');
  await mkdir(folder);
  await assert.rejects(loadPlayerCatalogSnapshot(folder, id), /snapshot/i);
  for (const bytes of [Buffer.alloc(1024 * 1024 + 1), Buffer.from([0xff]), Buffer.from('{')]) {
    await writeFile(file, bytes);
    await assert.rejects(loadPlayerCatalogSnapshot(file, id), /snapshot/i);
  }
});
