import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { playerCatalog } from '../src/player-catalog.js';
import { parsePlayerCatalogSnapshot } from '../src/player-catalog-file.js';
import {
  createPlayerCatalogSnapshot,
  playerCatalogEntryId,
} from '../src/player-catalog-snapshot.js';
import { upstreamFixture } from './player-cache-fixture.js';

const noticeReissueBytes = readFileSync(
  new URL('../../../../docs/operations/published-notice-reissue-2026-11-07.json', import.meta.url),
);
const noticeReissue = JSON.parse(noticeReissueBytes.toString('utf8'));
const noticeReissueSha256 = createHash('sha256').update(noticeReissueBytes).digest('hex');
function reissuedProfile(id: string) {
  const profile = noticeReissue.profiles.find((row: { id: string }) => row.id === id);
  assert.ok(profile);
  return profile;
}

test('published source-built packages retain matching pinned source, notice and build receipts', () => {
  for (const id of [
    'prosystem',
    'stella2014',
    'freeintv',
    'atari800',
    'pokemini',
    'potator',
    'sameduck',
    'mednafen-pcfx',
  ]) {
    const entry = playerCatalog.find((entry) => entry.id === `org.libretro.${id}`);
    assert.ok(entry?.provenance);
    assert.equal(entry.provenance.sourceMapping, 'release-receipt');
    assert.ok(entry.provenance.license);
    const artifacts = (entry.provenance.artifacts ?? []).filter((artifact) =>
      artifact.url.includes('/releases/download/'),
    );
    assert.deepEqual(artifacts.map((artifact) => artifact.kind).sort(), [
      'build',
      'notices',
      'source',
    ]);
    for (const artifact of artifacts) {
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
      assert.ok(artifact.sizeBytes > 0);
      assert.equal(new URL(artifact.url).origin, 'https://github.com');
      if (artifact.kind === 'source')
        assert.equal(
          artifact.url.slice(0, artifact.url.lastIndexOf('/')),
          entry.url?.slice(0, entry.url.lastIndexOf('/')),
        );
    }
    const build = entry.provenance.artifacts?.find((artifact) => artifact.kind === 'build');
    assert.equal(build?.url, entry.provenance.sourceInfo);
    assert.equal(build?.sha256, entry.provenance.infoSha256);
  }
});

test('legacy packages retain reproduced source receipts while upstream mappings remain open', () => {
  const fceumm = playerCatalog.find((entry) => entry.id === 'org.libretro.fceumm');
  const jaguar = playerCatalog.find((entry) => entry.id === 'org.libretro.virtualjaguar');
  assert.equal(fceumm?.provenance?.sourceMapping, 'release-receipt');
  assert.ok(fceumm?.provenance);
  assert.equal(
    fceumm.provenance.artifacts?.find((artifact) => artifact.kind === 'source')?.sha256,
    reissuedProfile('org.libretro.fceumm').source.sha256,
  );
  assert.equal(jaguar?.provenance?.sourceMapping, 'release-receipt');
  assert.ok(jaguar?.provenance);
  assert.equal(
    jaguar.provenance.artifacts?.find((artifact) => artifact.kind === 'source')?.sha256,
    reissuedProfile('org.libretro.virtualjaguar').source.sha256,
  );
  for (const entry of playerCatalog.filter((entry) => entry.upstream))
    assert.notEqual(entry.provenance?.sourceMapping, 'release-receipt');
});

function enriched() {
  const entry = upstreamFixture().entry;
  entry.provenance = {
    sourceInfo: 'https://example.com/build.json',
    infoSha256: 'a'.repeat(64),
    license: 'Generated fixture',
    sourceMapping: 'release-receipt',
    artifacts: ['source', 'notices', 'build'].map((kind) => ({
      kind: kind as 'source' | 'notices' | 'build',
      url: `https://example.com/${kind === 'build' ? 'build.json' : kind}`,
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
    })),
  };
  return entry;
}

test('snapshot identities retain provenance artifact pins while old snapshots stay readable', () => {
  const entry = enriched();
  const snapshot = createPlayerCatalogSnapshot([entry]);
  assert.deepEqual(parsePlayerCatalogSnapshot(snapshot, snapshot.id), snapshot);
  const changed = structuredClone(entry);
  const artifact = changed.provenance?.artifacts?.[0];
  assert.ok(artifact);
  artifact.sha256 = 'b'.repeat(64);
  assert.notEqual(playerCatalogEntryId(entry), playerCatalogEntryId(changed));
  const old = createPlayerCatalogSnapshot([upstreamFixture().entry]);
  assert.equal(parsePlayerCatalogSnapshot(old, old.id).id, old.id);
});

for (const mode of [
  'kind',
  'kind-array',
  'mapping-array',
  'hash',
  'size',
  'credentials',
  'http',
  'unknown',
  'incomplete',
  'duplicate',
] as const) {
  test(`provenance rejects invalid ${mode} metadata without downloading anything`, (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      throw new Error('No metadata fetch');
    });
    const entry = enriched();
    const provenance = entry.provenance;
    const artifact = provenance?.artifacts?.[0];
    assert.ok(provenance && artifact);
    if (mode === 'kind') Object.assign(artifact, { kind: 'executable' });
    if (mode === 'kind-array') {
      provenance.sourceMapping = 'unverified';
      Object.assign(artifact, { kind: ['source'] });
    }
    if (mode === 'mapping-array') Object.assign(provenance, { sourceMapping: ['unverified'] });
    if (mode === 'hash') artifact.sha256 = 'bad';
    if (mode === 'size') artifact.sizeBytes = 0;
    if (mode === 'credentials') artifact.url = 'https://generated-secret@example.com/source';
    if (mode === 'http') artifact.url = 'http://example.com/source';
    if (mode === 'unknown') Object.assign(artifact, { ignored: true });
    if (mode === 'incomplete') provenance.artifacts = [artifact];
    if (mode === 'duplicate') provenance.artifacts?.push({ ...artifact });
    const snapshot = createPlayerCatalogSnapshot([entry]);
    assert.throws(() => parsePlayerCatalogSnapshot(snapshot, snapshot.id), /snapshot/i);
    assert.equal(calls, 0);
  });
}

test('retained legacy source mappings bind the exact audit bytes and package pins', () => {
  const bytes = readFileSync(
    new URL('../../../../docs/operations/core-source-audit-2026-11-05.json', import.meta.url),
  );
  const audit = JSON.parse(bytes.toString('utf8'));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  for (const id of ['org.libretro.fceumm', 'org.libretro.virtualjaguar']) {
    const entry = playerCatalog.find((e) => e.id === id);
    const record = audit.packages.find((p: { id: string }) => p.id === id);
    assert.ok(entry?.provenance && record);
    assert.equal(record.rebuild.state, 'matched');
    assert.equal(record.rebuild.scope, 'loader-and-wasm');
    assert.equal(record.package.sha256, reissuedProfile(id).originalPackage.sha256);
    assert.equal(entry.sha256, reissuedProfile(id).package.sha256);
    assert.equal(reissuedProfile(id).originalBuildEvidence.sha256, sha256);
    assert.equal(entry.provenance.infoSha256, noticeReissueSha256);
    const source = entry.provenance.artifacts?.find((a) => a.kind === 'source');
    assert.deepEqual(record.source, reissuedProfile(id).originalSource);
    assert.deepEqual(source, { kind: 'source', ...reissuedProfile(id).source });
    const build = entry.provenance.artifacts?.find((a) => a.kind === 'build');
    assert.equal(build?.sha256, noticeReissueSha256);
    assert.equal(build?.sizeBytes, noticeReissueBytes.length);
    assert.match(build?.url ?? '', /\/browser-core-notices-2026\.11\.07\.1\/catalog\.json$/);
  }
  const custom = playerCatalog.filter((entry) => entry.url && !entry.upstream);
  assert.equal(custom.length, audit.packages.length);
  for (const entry of custom) {
    const sdk =
      entry.provenance?.artifacts?.filter((a) => a.url.includes('/emscripten-core/emscripten/')) ??
      [];
    for (const { path: _path, ...notice } of audit.sdkNotices)
      assert.ok(
        sdk.some((artifact) => artifact.sha256 === notice.sha256 && artifact.url === notice.url),
      );
  }
  const upstream = playerCatalog.filter((entry) => entry.upstream);
  assert.deepEqual(
    audit.upstream.profiles.map((p: { id: string }) => p.id).sort(),
    upstream.map((p) => p.id).sort(),
  );
});

test('eight independently reconstructed packages bind immutable build and compiler notice inventories', () => {
  const bytes = readFileSync(
    new URL(
      '../../../../docs/operations/custom-build-verification-2026-11-06.json',
      import.meta.url,
    ),
  );
  const proof = JSON.parse(bytes.toString('utf8'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const inventoryBytes = readFileSync(
    new URL('../../../../docs/operations/custom-build-notices-2026-11-06.json', import.meta.url),
  );
  const inventory = JSON.parse(inventoryBytes.toString('utf8'));
  assert.equal(
    proof.noticeInventory.sha256,
    createHash('sha256').update(inventoryBytes).digest('hex'),
  );
  assert.equal(proof.noticeInventory.sizeBytes, inventoryBytes.length);
  assert.equal(proof.builds.length, 8);
  for (const record of proof.builds) {
    const entry = playerCatalog.find((e) => e.id === record.id);
    assert.ok(entry?.provenance);
    assert.equal(record.reconstructedPackage.matchesPublished, true);
    assert.equal(
      record.reconstructedPackage.sha256,
      reissuedProfile(record.id).originalPackage.sha256,
    );
    assert.equal(entry.sha256, reissuedProfile(record.id).package.sha256);
    assert.equal(
      record.reconstructedPackage.sizeBytes,
      reissuedProfile(record.id).originalPackage.sizeBytes,
    );
    assert.equal(entry.downloadBytes, reissuedProfile(record.id).package.sizeBytes);
    assert.equal(record.freshSourceExtraction, true);
    assert.equal(record.debugRelinkBytesMatch, true);
    assert.equal(record.unresolvedDependencyCount, 0);
    assert.equal(record.generatedProjectInputs.length, 0);
    assert.equal(record.linkArchiveInputs.length, 13);
    assert.ok(
      record.resources.every(
        (resource: { matchesPublished: boolean }) => resource.matchesPublished,
      ),
    );
    assert.deepEqual(
      entry.provenance.artifacts?.find((a) => a.kind === 'source'),
      { kind: 'source', ...reissuedProfile(record.id).source },
    );
    const build = entry.provenance.artifacts?.find((a) => a.kind === 'build');
    assert.equal(reissuedProfile(record.id).originalBuildEvidence.sha256, digest);
    assert.equal(build?.sha256, noticeReissueSha256);
    assert.equal(build?.sizeBytes, noticeReissueBytes.length);
    assert.equal(entry.provenance.sourceInfo, build?.url);
    assert.equal(entry.provenance.infoSha256, noticeReissueSha256);
    assert.match(build?.url ?? '', /\/browser-core-notices-2026\.11\.07\.1\/catalog\.json$/);
    const notices = entry.provenance.artifacts?.find(
      (a) => a.sha256 === proof.noticeInventory.sha256,
    );
    assert.equal(notices?.kind, 'notices');
    assert.equal(notices?.sizeBytes, inventoryBytes.length);
    assert.match(notices?.url ?? '', /\/[a-f0-9]{40}\/docs\/operations\/custom-build-notices/);
    const inputs = inventory.inputs.filter((input: { builds: string[] }) =>
      input.builds.includes(record.id),
    );
    assert.equal(inputs.length, record.reportedInputCount);
    for (const input of inputs) {
      if (input.path.startsWith('source/')) assert.equal(input.archiveMemberBytesVerified, true);
      else
        assert.ok(
          input.exactContentOrigins.length > 0 ||
            input.generationEvidence?.byteReconstructionMatches,
        );
      for (const span of input.inlineNotices) {
        assert.equal(span.endByte - span.startByte, span.sizeBytes);
        assert.ok(span.endLine >= span.startLine);
      }
    }
  }
  for (const entry of playerCatalog.filter((e) => e.url && !e.upstream)) {
    for (const notice of proof.sdkNotices)
      assert.ok(
        entry.provenance?.artifacts?.some(
          (artifact) =>
            artifact.url === notice.url &&
            artifact.sha256 === notice.sha256 &&
            artifact.sizeBytes === notice.sizeBytes,
        ),
      );
  }
  assert.equal(proof.sdkNotices.length, 9);
});

test('published notice revisions bind both original verification and carried redistribution materials', () => {
  assert.equal(noticeReissue.profiles.length, 10);
  assert.equal(noticeReissue.verification.runtimePairsByteIdentical, 10);
  assert.equal(noticeReissue.verification.freshRuntimePairComparisons, 2);
  assert.equal(noticeReissue.verification.freshSourceArchivesCompletelyReread, 2);
  assert.equal(noticeReissue.verification.inheritedUnchangedProfiles, 8);
  const componentBytes = readFileSync(
    new URL('../../../../docs/operations/notice-closure-2026-11-07.json', import.meta.url),
  );
  assert.equal(
    noticeReissue.method.componentNoticeEvidence.sha256,
    createHash('sha256').update(componentBytes).digest('hex'),
  );
  assert.equal(noticeReissue.method.componentNoticeEvidence.sizeBytes, componentBytes.length);
  for (const profile of noticeReissue.profiles) {
    const entry = playerCatalog.find((e) => e.id === profile.id);
    assert.ok(entry?.provenance);
    assert.equal(entry.url, profile.package.url);
    assert.equal(entry.sha256, profile.package.sha256);
    assert.equal(entry.downloadBytes, profile.package.sizeBytes);
    assert.equal(entry.provenance.infoSha256, noticeReissueSha256);
    assert.equal(profile.originalResourcesPreserved, true);
    assert.equal(profile.runtimeManifestPreservedExceptNoticeAssets, true);
    assert.equal(profile.sourceVerification.standaloneReproductionMatchesWholePackage, true);
    assert.equal(profile.sourceVerification.allOriginalMembersPreserved, true);
    assert.equal(profile.sourceVerification.fullArchiveReread, true);
    assert.equal(profile.sourceVerification.standalonePackageReproductionIncluded, true);
    const files = profile.notices.map((n: { file: string }) => n.file);
    const fresh = ['org.libretro.atari800', 'org.libretro.potator'].includes(profile.id);
    assert.equal(
      profile.verificationOrigin,
      fresh
        ? 'fresh-two-profile-notice-reissue'
        : 'inherited-byte-identical-November-6-publication',
    );
    assert.equal(files.includes('atari800-caprice32.txt'), profile.id === 'org.libretro.atari800');
    for (const name of [
      'potator-m6502-source.txt',
      'potator-m6502-header.txt',
      'potator-m6502-tables.txt',
    ])
      assert.equal(files.includes(name), profile.id === 'org.libretro.potator');
    assert.ok(files.includes('sha1-fpl.txt'));
    assert.ok(files.includes('recovered-notice-evidence.json'));
    assert.equal(files.includes('ijg-v4-README.txt'), profile.id === 'org.libretro.mednafen-pcfx');
    assert.equal(
      files.includes('ijg-modifications.txt'),
      profile.id === 'org.libretro.mednafen-pcfx',
    );
    assert.equal(entry.provenance.artifacts?.filter((a) => a.kind === 'build').length, 1);
    assert.ok((entry.provenance.artifacts?.length ?? 0) <= 16);
  }
});
