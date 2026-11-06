import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ServerUpdater } from '../src/server-updater.js';
import { archiveBase, type Build, extension, platform, target } from '../src/update-files.js';
import { findUpdate, stageUpdate, type UpdateCandidate } from '../src/update-release.js';

const installed: Build = {
  id: 'a'.repeat(64),
  channel: 'nightly',
  version: 'nightly-aaaaaaaaaaaa',
  sha: 'a'.repeat(40),
  platform,
  arch: process.arch,
  builtAt: '2026-10-01T00:00:00Z',
};
const newer: Build = {
  ...installed,
  id: 'b'.repeat(64),
  sha: 'b'.repeat(40),
  version: 'nightly-bbbbbbbbbbbb',
  builtAt: '2026-10-02T00:00:00Z',
};
const update: UpdateCandidate = {
  build: newer,
  url: 'https://example.invalid/archive',
  digest: 'c'.repeat(64),
  size: 3,
};

test('manual decisions persist per build and automatic mode stages a newer build', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-update-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let next = update;
  let checks = 0;
  const stages: string[] = [];
  const restarts: string[] = [];
  const open = () =>
    ServerUpdater.open(
      directory,
      installed,
      async (id) => {
        restarts.push(id);
      },
      {
        find: async () => {
          checks++;
          return next;
        },
        stage: async (_directory, selected) => {
          stages.push(selected.build.id);
        },
      },
    );
  let controller = await open();
  t.after(() => controller.stop());
  controller.start();
  assert.equal(checks, 0);
  assert.equal(controller.status().settings.mode, 'off');
  await controller.configure({ channel: 'nightly', mode: 'manual' });
  assert.equal(controller.status().prompt, true);
  await controller.decide({ action: 'install', buildId: installed.id });
  assert.deepEqual(stages, []);
  await controller.decide({ action: 'later', buildId: newer.id });
  assert.equal(controller.status().prompt, false);
  await controller.stop();

  controller = await open();
  controller.start();
  await delay(0);
  assert.equal(controller.status().prompt, false);
  await controller.decide({ action: 'skip', buildId: newer.id });
  await controller.configure({ channel: 'nightly', mode: 'automatic' });
  await delay(0);
  assert.deepEqual(stages, []);

  next = { ...update, build: { ...newer, id: 'd'.repeat(64) } };
  await controller.decide({ action: 'check' });
  await delay(0);
  assert.deepEqual(stages, [next.build.id]);
  assert.deepEqual(restarts, [next.build.id]);
  assert.equal(controller.status().phase, 'restarting');
});

test('release selection ignores unrelated GitHub releases and checks the platform digest', async () => {
  const release = { ...newer, channel: 'release', version: 'v0.2.0-alpha.1' };
  const archive = `${archiveBase(release.version)}.${extension}`;
  const manifest = `ecs-update-${target}.json`;
  const signal = new AbortController().signal;
  let digest = update.digest;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/releases?'))
      return Response.json([
        { tag_name: 'v9.0.0-core.1', draft: false, assets: [{ name: 'core.ecsplayer', size: 10 }] },
        {
          tag_name: release.version,
          draft: false,
          assets: [
            { name: archive, size: 3, digest: `sha256:${digest}` },
            { name: manifest, size: 512 },
          ],
        },
      ]);
    assert.ok(url.endsWith(`/${release.version}/${manifest}`));
    return Response.json({ build: release, archive, sha256: update.digest });
  };
  const selected = await findUpdate('release', installed, signal, fetcher);
  assert.equal(selected?.build.version, release.version);
  assert.ok(selected?.url.endsWith(archive));
  digest = '0'.repeat(64);
  await assert.rejects(findUpdate('release', installed, signal, fetcher), /manifest is invalid/);
});

test('download with a mismatched checksum never reaches extraction or stages a build', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-update-checksum-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    stageUpdate(directory, update, new AbortController().signal, async () => new Response('bad')),
    /checksum did not match/,
  );
  assert.deepEqual(await readdir(directory), []);
});
