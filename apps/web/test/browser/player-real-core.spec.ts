/** Opt-in acceptance: real external FCEUmm, original assembly fixture, ephemeral server only. */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContentClient } from '@ecs/client';
import { expect, test } from '@playwright/test';
import { installPinnedPlayer } from '../../../../scripts/browser-core/install-plugin.mjs';
import { openServer } from '../../../server/dist/src/index.js';

const externalCore = process.env.ECS_ACCEPTANCE_CORE;
if (externalCore) test.use({ headless: process.env.ECS_ACCEPTANCE_HEADLESS === '1' });
test('real FCEUmm plugin renders, accepts input, produces audio, and round-trips battery/state', async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    !externalCore,
    'Set ECS_ACCEPTANCE_CORE to an external pinned build; no emulator is bundled.',
  );
  test.setTimeout(180_000);
  const directory = await mkdtemp(join(tmpdir(), 'ecs-real-player-'));
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  let server: Awaited<ReturnType<typeof openServer>> | undefined;
  try {
    const registry = join(directory, 'players');
    await mkdir(registry);
    await installPinnedPlayer(resolve(externalCore ?? ''), join(registry, 'fceumm'));
    const program = join(directory, 'acceptance.nes');
    execFileSync('ca65', [
      resolve('../../examples/browser-playback/acceptance.s'),
      '-o',
      join(directory, 'program.o'),
    ]);
    execFileSync('ld65', [
      '-C',
      resolve('../../examples/browser-playback/nes.cfg'),
      join(directory, 'program.o'),
      '-o',
      program,
    ]);
    server = await openServer({
      dataDir: join(directory, 'data'),
      uiDir: resolve('dist'),
      playerPluginsDir: registry,
      localTrust: false,
      logger: false,
    });
    const secret = randomBytes(32).toString('hex');
    server.catalog.saveBootstrapHash(createHash('sha256').update(secret).digest('hex'));
    const origin = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const client = new ContentClient(origin);
    const session = await client.bootstrap(
      secret,
      'acceptance-owner',
      randomBytes(24).toString('hex'),
    );
    const library = await client.createLibrary({ name: 'Generated acceptance' });
    const item = await client.createItem({
      libraryId: library.id,
      title: 'Original acceptance program',
      systemIdentifier: 'com.provenance.nes',
      md5: null,
      crc: null,
    });
    const rom = await client.upload({
      libraryId: library.id,
      itemId: item.id,
      kind: 'rom',
      displayName: 'acceptance.nes',
      relativePath: 'acceptance.nes',
      baseRevision: item.revision,
      body: await readFile(program),
    });
    const profiles = await client.playerProfiles();
    expect(profiles.items.map((p) => p.id)).toEqual(['org.libretro.fceumm']);
    expect((await fetch(`${origin}/api/v1/player/core`)).status).toBe(404);
    expect((await fetch(`${origin}/play/plugins/org.libretro.fceumm/loader.js`)).status).toBe(401);
    await page.addInitScript(
      ({ origin, session }) => {
        if (window === top && location.origin === origin)
          localStorage.setItem(
            `ecs.session:${encodeURIComponent(origin)}`,
            JSON.stringify(session),
          );
        const probe = { buffers: 0, peak: 0 };
        Object.assign(window, { __ecsAudioProbe: probe });
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof start>) {
          if (this.buffer) {
            probe.buffers++;
            const samples = this.buffer.getChannelData(0);
            for (let i = 0; i < samples.length; i++)
              probe.peak = Math.max(probe.peak, Math.abs(samples[i] ?? 0));
          }
          return start.apply(this, args);
        };
      },
      { origin, session },
    );
    const url = `${origin}/play/?item=${item.id}&asset=${rom.id}&profile=org.libretro.fceumm`;
    const battery = page.getByRole('button', { name: 'Save battery', exact: true });
    const state = page.getByRole('button', { name: 'Save state', exact: true });
    async function start(batteryId?: string, stateId?: string) {
      await page.goto(url);
      await expect(page.getByRole('combobox', { name: 'Emulator', exact: true })).toHaveValue(
        'org.libretro.fceumm',
      );
      if (batteryId)
        await page
          .getByRole('combobox', { name: 'Compatible battery save', exact: true })
          .selectOption(batteryId);
      if (stateId)
        await page
          .getByRole('combobox', { name: 'Compatible slot-0 state', exact: true })
          .selectOption(stateId);
      if (batteryId || stateId) await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(battery, await page.locator('main').innerText()).toBeEnabled({
        timeout: 45_000,
      });
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
      await page.frameLocator('iframe').locator('canvas').click();
      await page.waitForTimeout(1000);
    }
    async function saveBattery(expected: number) {
      await battery.focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('status', { name: '' }).filter({ hasText: 'Operation completed.' }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(battery).toBeEnabled();
      const file = (await client.manifest(item.id)).files.find(
        (f) => f.kind === 'battery_save' && !f.conflictOf,
      );
      if (!file) throw new Error('Battery save missing');
      const bytes = (await client.collect(file.id)).bytes;
      expect(bytes.length).toBe(8192);
      expect(Array.from(bytes.slice(0, 2))).toEqual([expected, 0xa7]);
      return file.id;
    }
    async function pressA() {
      const display = page.frameLocator('iframe').locator('canvas');
      await display.click();
      await page.keyboard.down('x');
      await page.waitForTimeout(100);
      await page.keyboard.up('x');
      await page.waitForTimeout(100);
    }
    await page.bringToFront();
    await start();
    const first = await page.frameLocator('iframe').locator('canvas').screenshot();
    await saveBattery(1);
    await pressA();
    const second = await page.frameLocator('iframe').locator('canvas').screenshot();
    expect(createHash('sha256').update(first).digest('hex')).not.toBe(
      createHash('sha256').update(second).digest('hex'),
    );
    await mkdir(testInfo.outputDir, { recursive: true });
    const picture = testInfo.outputPath('real-fceumm-counter-2.png');
    await writeFile(picture, second);
    await testInfo.attach('real-fceumm-counter-2', { path: picture, contentType: 'image/png' });
    const battery2 = await saveBattery(2);
    await state.click();
    await expect(state).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    const savedState = (await client.manifest(item.id)).files.find(
      (f) => f.kind === 'save_state' && !f.conflictOf,
    );
    if (!savedState) throw new Error('State missing');
    expect((await client.collect(savedState.id)).bytes.length).toBeGreaterThan(0);
    const frame = page.frames().find((f) => f.url().includes('/play/sandbox.html'));
    if (!frame) throw new Error('Runtime frame missing');
    const audio = await frame.evaluate(
      () =>
        (window as unknown as { __ecsAudioProbe: { buffers: number; peak: number } })
          .__ecsAudioProbe,
    );
    expect(audio.buffers).toBeGreaterThan(0);
    expect(audio.peak).toBeGreaterThan(0.001);
    await start(battery2);
    await saveBattery(2);
    await pressA();
    const battery3 = await saveBattery(3);
    await start(battery3, savedState.id);
    await saveBattery(2);
    await page.getByRole('link', { name: 'Stop and return to library' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${origin}/ui/`);
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(runtimeErrors).toEqual([]);
    const report = testInfo.outputPath('real-core-results.json');
    await writeFile(
      report,
      JSON.stringify(
        {
          profile: profiles.items[0],
          browser: browser.version(),
          platform: process.platform,
          audio,
          batteryCounters: [1, 2, 2, 3, 2],
          originalProgram: 'examples/browser-playback/acceptance.s',
        },
        null,
        2,
      ),
    );
    await testInfo.attach('real-core-results', { path: report, contentType: 'application/json' });
  } catch (error) {
    await mkdir(testInfo.outputDir, { recursive: true });
    await page
      .screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true })
      .catch(() => {});
    console.log(
      'Player failure details:',
      await page
        .locator('main')
        .textContent()
        .catch(() => 'Document unavailable'),
    );
    throw error;
  } finally {
    await page.goto('about:blank');
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
