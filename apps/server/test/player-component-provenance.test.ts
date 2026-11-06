import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { playerCatalog } from '../src/player-catalog.js';

function evidence(name: string) {
  const path = `docs/operations/${name}-2026-11-06.json`;
  const bytes = readFileSync(new URL(`../../../../${path}`, import.meta.url));
  return {
    record: JSON.parse(bytes.toString('utf8')),
    ref: {
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    },
  };
}

test('all fifty upstream pairs retain exact partial evidence with unverified build mappings', () => {
  const { record, ref } = evidence('upstream-binary-mapping');
  const upstream = playerCatalog.filter((entry) => entry.upstream);
  assert.equal(upstream.length, 50);
  assert.deepEqual(
    record.profiles.map((p: { id: string }) => p.id).sort(),
    upstream.map((p) => p.id).sort(),
  );
  for (const profile of record.profiles) {
    const entry = upstream.find((entry) => entry.id === profile.id);
    assert.ok(entry?.upstream);
    assert.equal(entry.provenance?.sourceMapping, 'unverified');
    assert.equal(profile.sourceMapping, 'unverified');
    assert.equal(profile.frontendRevision.status, 'embedded-self-report-resolved');
    assert.ok(profile.frontendRevision.commit.startsWith(profile.frontendRevision.abbreviation));
    for (const resource of entry.upstream.resources) {
      const proof = profile.resources.find((p: { file: string }) => p.file === resource.file);
      assert.ok(proof?.pinMatches);
      assert.equal(proof.sha256, resource.sha256);
      assert.equal(proof.sizeBytes, resource.sizeBytes);
    }
    const build = entry.provenance?.artifacts?.find((artifact) => artifact.kind === 'build');
    assert.equal(build?.sha256, ref.sha256);
    assert.equal(build?.sizeBytes, ref.sizeBytes);
    assert.match(build?.url ?? '', /\/[a-f0-9]{40}\/docs\/operations\/upstream-binary-mapping/);
    assert.ok(profile.remainingUnverifiedInputs.length > 0);
  }
  assert.equal(record.counts.coreRevisionSelfReportsResolved, 39);
  assert.equal(record.counts.coreRevisionUnresolved, 11);
  assert.equal(record.counts.fullSourceBuildMappingsVerified, 0);
});

test('custom entries retain full component and selected SDK notice evidence', () => {
  const components = evidence('component-notice-audit');
  const sdk = evidence('sdk-link-notices');
  const inputs = evidence('custom-build-notices');
  assert.deepEqual(components.record.inputInventory.sha256, inputs.ref.sha256);
  assert.equal(components.record.components.length, 43);
  for (const component of components.record.components) {
    for (const index of component.inputIndexes) assert.ok(inputs.record.inputs[index]);
    for (const index of component.noticeIndexes) assert.ok(components.record.noticeEvidence[index]);
  }
  const custom = playerCatalog.filter((entry) => entry.url && !entry.upstream);
  assert.equal(custom.length, 10);
  for (const entry of custom) {
    for (const report of [components, sdk]) {
      const artifact: { kind: string; sizeBytes?: number; url: string } | undefined =
        entry.provenance?.artifacts?.find((a) => a.sha256 === report.ref.sha256);
      assert.equal(artifact?.kind, 'notices');
      assert.equal(artifact?.sizeBytes, report.ref.sizeBytes);
      assert.match(artifact?.url ?? '', /\/[a-f0-9]{40}\/docs\/operations\//);
    }
    assert.ok((entry.provenance?.artifacts?.length ?? 0) <= 16);
    const link = sdk.record.builds.find((build: { id: string }) => build.id === entry.id);
    assert.equal(link?.matchesPriorVerifiedLink, true);
    for (const member of link.selectedSdkMembers) {
      const record = sdk.record.selectedMembers.find((row: { id: string }) => row.id === member);
      assert.ok(
        record &&
          sdk.record.sourceNoticeEvidence.some(
            (row: { path: string }) => row.path === record.recipeSource,
          ),
      );
    }
  }
  assert.equal(sdk.record.selectedMembers.length, 335);
  assert.match(
    playerCatalog.find((e) => e.id === 'org.libretro.atari800')?.provenance?.license ?? '',
    /Caprice32.*noncommercial/i,
  );
  assert.match(
    playerCatalog.find((e) => e.id === 'org.libretro.potator')?.provenance?.license ?? '',
    /M65C02.*noncommercial/i,
  );
});

test('legacy notice closure retains source patch evidence and hash-bound component references', () => {
  const proof = evidence('legacy-build-verification');
  const inventory = evidence('legacy-build-notices');
  const components = evidence('legacy-component-notices');
  assert.equal(proof.record.noticeInventory.sha256, inventory.ref.sha256);
  assert.equal(proof.record.noticeInventory.sizeBytes, inventory.ref.sizeBytes);
  assert.deepEqual(proof.record.componentMatrix, components.ref);
  assert.deepEqual(components.record.modernMatrix, evidence('component-notice-audit').ref);
  assert.deepEqual(components.record.rootSdkLinkEvidence, evidence('sdk-link-notices').ref);
  assert.equal(inventory.record.inputs.length, 2714);
  assert.equal(components.record.components.length, 15);
  assert.equal(proof.record.fceummPatch.reconstructedFromArchiveAndRetainedPatch, true);
  for (const row of Object.values(proof.record.sourceVerification) as {
    failedCompileCount: number;
    unresolvedCount: number;
    notInArchive: string[];
  }[]) {
    assert.equal(row.failedCompileCount, 0);
    assert.equal(row.unresolvedCount, 0);
    assert.deepEqual(row.notInArchive, []);
  }
  for (const build of proof.record.builds) {
    assert.ok(build.resources.every((r: { matchesPublished: boolean }) => r.matchesPublished));
    const entry = playerCatalog.find((e) => e.id === build.id);
    assert.ok(entry?.provenance?.artifacts?.some((a) => a.sha256 === proof.ref.sha256));
    assert.ok(entry?.provenance?.artifacts?.some((a) => a.sha256 === inventory.ref.sha256));
  }
});

test('recovered SHA1 and IJG grants retain complete hash-bound redistribution materials', () => {
  const { record, ref } = evidence('sha1-ijg-resolution');
  assert.equal(record.components[0].grantNameAsPublished, 'Freeware Public License (FPL)');
  assert.equal(record.components[0].authorArchiveFingerprintVerified, true);
  assert.equal(record.components[0].incorporatedFiles.length, 10);
  assert.equal(record.components[0].allTenIncorporatedFilesByteIdentical, true);
  assert.equal(record.components[1].headersByteIdentical, true);
  for (const component of record.components) {
    for (const match of component.matches) assert.equal(match.equalAfterNormalization, true);
  }
  for (const material of record.retainedRedistributionMaterials) {
    const bytes = readFileSync(new URL(`../../../../${material.path}`, import.meta.url));
    assert.equal(bytes.length, material.sizeBytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), material.sha256);
  }
  for (const entry of playerCatalog.filter((entry) => entry.url && !entry.upstream)) {
    const artifact = entry.provenance?.artifacts?.find((a) => a.sha256 === ref.sha256);
    assert.equal(artifact?.kind, 'notices');
    assert.equal(artifact?.sizeBytes, ref.sizeBytes);
    assert.match(artifact?.url ?? '', /\/[a-f0-9]{40}\/docs\/operations\/sha1-ijg-resolution/);
    assert.equal(entry.provenance?.artifacts?.length, 16);
  }
});

test('upstream CI candidates stay distinct from reproducible pairs and complete mappings', () => {
  const ci = evidence('upstream-build-resolution');
  const rebuild = evidence('vecx-upstream-rebuild');
  assert.equal(ci.record.profiles.length, 11);
  const jobs = ci.record.profiles.flatMap((p: { candidates: { jobs: unknown[] }[] }) =>
    p.candidates.flatMap((c) => c.jobs),
  ) as { status: string; erased_at: string; artifacts: unknown[] }[];
  assert.equal(jobs.length, 14);
  for (const job of jobs) {
    assert.equal(job.status, 'success');
    assert.ok(job.erased_at);
    assert.deepEqual(job.artifacts, []);
  }
  assert.equal(rebuild.record.status, 'exact-runtime-pair-reproduced');
  assert.equal(rebuild.record.compilerCapture.failedCommands, 0);
  assert.equal(rebuild.record.compilerCapture.inputs.length, 1071);
  assert.equal(
    rebuild.record.compilerCapture.inputs.filter(
      (input: { origin: string }) => input.origin === 'pinned-archive',
    ).length,
    972,
  );
  for (const input of rebuild.record.compilerCapture.inputs) {
    if (input.origin === 'pinned-archive') assert.equal(input.matchesSourceArchive, true);
  }
  const vecx = playerCatalog.find((entry) => entry.id === rebuild.record.id);
  for (const resource of rebuild.record.resources) {
    const pin = vecx?.upstream?.resources.find((r) => r.file === resource.file);
    assert.ok(pin);
    assert.equal(resource.matchesPublished, true);
    assert.equal(resource.sha256, pin.sha256);
    assert.equal(resource.sizeBytes, pin.sizeBytes);
  }
  for (const entry of playerCatalog.filter((entry) => entry.upstream)) {
    assert.equal(entry.provenance?.sourceMapping, 'unverified');
    for (const report of entry.id === rebuild.record.id ? [ci, rebuild] : [ci]) {
      const artifact: { kind: string; sizeBytes?: number; url: string } | undefined =
        entry.provenance?.artifacts?.find((a) => a.sha256 === report.ref.sha256);
      assert.equal(artifact?.kind, 'build');
      assert.equal(artifact?.sizeBytes, report.ref.sizeBytes);
      assert.match(artifact?.url ?? '', /\/[a-f0-9]{40}\/docs\/operations\//);
    }
  }
});
