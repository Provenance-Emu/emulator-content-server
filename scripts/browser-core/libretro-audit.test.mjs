import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedDownload, parseCoreInfo, parseCoreList } from './libretro-audit.mjs';

test('official list and info parsing preserves case and numbered firmware fields without executing source', () => {
  assert.deepEqual(
    parseCoreList(
      'const cores = {\n "DoubleCherryGB": "GB",\n "gearboy": "GB",\n "gearboy": "duplicate"\n}; throw Error("never executed");',
    ),
    ['DoubleCherryGB', 'gearboy'],
  );
  assert.deepEqual(
    parseCoreInfo(
      'firmware0_path = "MacII.ROM"\nfirmware0_opt = "false"\nsupported_extensions = "dsk|img"',
    ),
    { firmware0_path: 'MacII.ROM', firmware0_opt: 'false', supported_extensions: 'dsk|img' },
  );
});
test('download cap cancels advertised and streaming overflows before accumulating the body', async () => {
  let cancelled = 0;
  const fake = (chunks, length) => async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const bytes of chunks) controller.enqueue(Uint8Array.from(bytes));
        },
        cancel() {
          cancelled++;
        },
      }),
      { headers: length ? { 'content-length': length } : {} },
    );
  await assert.rejects(boundedDownload('https://example.invalid', 3, fake([[1]], '4')), /byte cap/);
  await assert.rejects(
    boundedDownload(
      'https://example.invalid',
      3,
      fake([
        [1, 2],
        [3, 4],
      ]),
    ),
    /byte cap/,
  );
  assert.equal(cancelled, 2);
  const result = await boundedDownload('https://example.invalid', 3, async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return new Response(Uint8Array.of(42, 7));
  });
  assert.deepEqual([...result.bytes], [42, 7]);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
});

test('manual buildbot plans preserve exact source pins, two workers and no implicit publication', async () => {
  const { buildPlan, runBuildbot } = await import('./buildbot.mjs');
  for (const id of ['fceumm', 'prosystem', 'pcsx-rearmed', 'virtualjaguar']) {
    const plan = buildPlan(id);
    assert.equal(plan.parallelism, 2);
    assert.equal(plan.publication, 'none');
    assert.equal(plan.emsdk.version, '3.1.46');
    assert.equal(plan.emsdk.compilerRevision, '19607820c447a13fd8d0b7680c56148427d6e1b8');
    assert.match(plan.core.revision, /^[a-f0-9]{40}$/);
    assert.match(plan.core.rebuild, /^rebuild-[a-z-]+-source\.mjs$/);
  }
  assert.throws(() => buildPlan('flycast'), /Unknown/);
  assert.throws(() => buildPlan('../../arbitrary'), /Unknown/);
  await assert.rejects(
    runBuildbot('prosystem', new URL('./must-not-build', import.meta.url).pathname),
    /outside repository/,
  );
});

test('central workflow defaults to artifact-only and publication forces source reproduction without replacing desktop latest', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(
    new URL('../../.github/workflows/browser-cores.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^ {2}(push|schedule|pull_request):/m);
  assert.match(workflow, /publish_release:[\s\S]*?default: false/);
  assert.ok(workflow.includes('"$VERIFY_REBUILD" == "true" || "$PUBLISH_RELEASE" == "true"'));
  assert.ok(workflow.includes('EXTRA+=(--verify-rebuild)'));
  assert.ok(workflow.includes("catalog.json').reproducible!==true"));
  assert.ok(workflow.includes('--prerelease --latest=false'));
  assert.ok(workflow.includes('Existing tags are immutable'));
  assert.ok(workflow.includes('Existing releases are immutable'));
});
