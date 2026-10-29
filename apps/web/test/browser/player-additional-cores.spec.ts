/** Opt-in acceptance of real BIOS-free cores with original generated programs. */
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { ContentClient } from '@ecs/client';
import { expect, test } from '@playwright/test';
import { psxSmokeCode, psxSmokeExe } from '../../../../scripts/browser-core/generate-psx-smoke.mjs';
import {
  dreamcastSmokeElf,
  naomiSmokeZip,
  sh4SmokeCode,
} from '../../../../scripts/browser-core/generate-sh4-smoke.mjs';
import {
  jaguarSmokeAbs,
  jaguarSmokeCartridge,
  jaguarSmokeCdi,
} from '../../../../scripts/browser-core/generate-smoke-program.mjs';
import { openServer } from '../../../server/dist/src/index.js';

/** Inspect compositor output instead of a possibly discarded WebGL backbuffer. */
function centerPixel(png: Buffer): number[] {
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20);
  const channels = png[25] === 2 ? 3 : png[25] === 6 ? 4 : 0;
  if (png[24] !== 8 || !channels) throw new Error('Unsupported screenshot PNG');
  const parts: Buffer[] = [];
  for (let pos = 8; pos + 12 <= png.length; ) {
    const size = png.readUInt32BE(pos);
    if (png.toString('ascii', pos + 4, pos + 8) === 'IDAT')
      parts.push(png.subarray(pos + 8, pos + 8 + size));
    pos += size + 12;
  }
  const bytes = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  let previous = Buffer.alloc(stride),
    offset = 0;
  for (let y = 0; y <= Math.floor(height / 2); y++) {
    const filter = bytes[offset++],
      row = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = row[i - channels] ?? 0,
        b = previous[i] ?? 0,
        c = previous[i - channels] ?? 0;
      const p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const pred =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : filter === 4
                  ? paeth
                  : NaN;
      if (!Number.isFinite(pred)) throw new Error('Unsupported PNG filter');
      row[i] = ((bytes[offset++] ?? 0) + pred) & 255;
    }
    previous = row;
  }
  return [
    ...previous.subarray(Math.floor(width / 2) * channels, Math.floor(width / 2) * channels + 3),
  ];
}

const jaguarPlugin = process.env.ECS_ACCEPTANCE_JAGUAR_PLUGIN;
const parallelPlugin = process.env.ECS_ACCEPTANCE_PARALLEL_DC_PLUGIN;
const psxPlugin = process.env.ECS_ACCEPTANCE_PSX_PLUGIN;
if (jaguarPlugin || parallelPlugin || psxPlugin)
  test.use({
    headless: process.env.ECS_ACCEPTANCE_HEADLESS === '1',
    ...(process.env.ECS_ACCEPTANCE_SOFTWARE_WEBGL === '1'
      ? { launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader'] } }
      : {}),
  });
const cases = [
  {
    title: 'PlayStation HLE',
    plugin: psxPlugin,
    profile: 'org.libretro.pcsx-rearmed',
    system: 'com.provenance.psx',
    program: psxSmokeExe(),
    filename: 'original.exe',
    needle: psxSmokeCode(),
    guestAddress: 0x10000,
    counterAddress: 0x20000,
    littleEndian: true,
  },
  ...(['abs', 'cartridge'] as const).map((format) => ({
    title: `BIOS-free Jaguar ${format}`,
    plugin: jaguarPlugin,
    profile: 'org.libretro.virtualjaguar',
    system: 'com.provenance.jaguar',
    program: format === 'abs' ? jaguarSmokeAbs() : jaguarSmokeCartridge(),
    filename: format === 'abs' ? 'original.abs' : 'original.j64',
    needle: jaguarSmokeAbs().subarray(0x24),
    guestAddress: format === 'abs' ? 0x4000 : 0x802000,
    counterAddress: 0x6000,
    littleEndian: false,
  })),
  {
    title: 'BIOS-free Jaguar CD',
    plugin: jaguarPlugin,
    profile: 'org.libretro.virtualjaguar',
    system: 'com.provenance.jaguarcd',
    program: jaguarSmokeCdi(),
    filename: 'original.cdi',
    needle: jaguarSmokeAbs().subarray(0x24),
    guestAddress: 0x4000,
    counterAddress: 0x6000,
    littleEndian: false,
  },
  ...(['dreamcast', 'naomi', 'naomi2'] as const).map((system) => ({
    title: `BIOS-free ${system}`,
    plugin: parallelPlugin,
    profile: 'org.libretro.parallel-dc',
    system: `com.provenance.${system}`,
    program: system === 'dreamcast' ? dreamcastSmokeElf() : naomiSmokeZip(system === 'naomi2'),
    filename: system === 'dreamcast' ? 'original.elf' : 'original.zip',
    needle: sh4SmokeCode(),
    guestAddress: system === 'dreamcast' ? 0x10000 : 0x20000,
    counterAddress: 0xf800,
    littleEndian: true,
  })),
];
for (const entry of cases) {
  test(`real ${entry.title} runs an original program in the opaque player`, async ({
    page,
    browser,
  }, testInfo) => {
    test.skip(
      !entry.plugin,
      'Set ECS_ACCEPTANCE_JAGUAR_PLUGIN or ECS_ACCEPTANCE_PARALLEL_DC_PLUGIN to an external player directory.',
    );
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'ecs-real-jaguar-'));
    const errors: string[] = [];
    const messages: string[] = [];
    page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
    page.on('console', (message) => {
      messages.push(message.text());
      if (
        process.env.ECS_ACCEPTANCE_RUNTIME_DIAGNOSTICS === '1' &&
        message.text().startsWith('ECS acceptance runtime error')
      )
        console.error(message.text());
    });
    if (process.env.ECS_ACCEPTANCE_RUNTIME_DIAGNOSTICS === '1')
      await page.route('**/play/sandbox.html', async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        const before = 'catch { if (!closed)';
        if (!body.includes(before))
          throw new Error('Acceptance diagnostic hook needs current sandbox');
        await route.fulfill({
          response,
          body: body.replace(
            before,
            'catch (error) { console.error("ECS acceptance runtime error", message.op, error?.stack ?? String(error)); if (!closed)',
          ),
        });
      });
    let server: Awaited<ReturnType<typeof openServer>> | undefined;
    try {
      const registry = join(directory, 'players');
      await mkdir(registry);
      await cp(resolve(entry.plugin ?? ''), join(registry, 'jaguar'), { recursive: true });
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
        'jaguar-owner',
        randomBytes(24).toString('hex'),
      );
      const library = await client.createLibrary({ name: 'Original Jaguar acceptance' });
      const item = await client.createItem({
        libraryId: library.id,
        title: 'Original green background program',
        systemIdentifier: entry.system,
        md5: null,
        crc: null,
      });
      const { program, filename } = entry;
      const rom = await client.upload({
        libraryId: library.id,
        itemId: item.id,
        kind: 'rom',
        displayName: filename,
        relativePath: filename,
        baseRevision: item.revision,
        body: program,
      });
      await page.addInitScript(
        ({ origin, session }) => {
          if (window === top && location.origin === origin)
            localStorage.setItem(
              `ecs.session:${encodeURIComponent(origin)}`,
              JSON.stringify(session),
            );
          const instantiate = WebAssembly.instantiate.bind(WebAssembly);
          WebAssembly.instantiate = (async (
            source: BufferSource | WebAssembly.Module,
            imports?: WebAssembly.Imports,
          ) => {
            const result = await instantiate(source as BufferSource, imports);
            const instance = result instanceof WebAssembly.Instance ? result : result.instance;
            const memory = Object.values(instance.exports).find(
              (value) => value instanceof WebAssembly.Memory,
            );
            if (memory) Object.assign(window, { __ecsSmokeMemory: memory });
            return result;
          }) as typeof WebAssembly.instantiate;
        },
        { origin, session },
      );
      await page.goto(`${origin}/play/?item=${item.id}&asset=${rom.id}&profile=${entry.profile}`);
      await expect(page.getByRole('combobox', { name: 'Emulator', exact: true })).toHaveValue(
        entry.profile,
      );
      await page.getByRole('button', { name: 'Start', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(
        page.getByText('This emulator profile does not provide save synchronization.', {
          exact: true,
        }),
      ).toBeVisible({ timeout: 45_000 });
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
      const frame = page.frames().find((f) => f.url().includes('/play/sandbox.html'));
      if (!frame) throw new Error('Runtime frame is missing');
      const needle = [...entry.needle];
      const { guestAddress, counterAddress, littleEndian } = entry;
      const counters = () =>
        frame.evaluate(
          ({ needle, guestAddress, counterAddress, littleEndian }) => {
            const memory = (window as unknown as { __ecsSmokeMemory?: WebAssembly.Memory })
              .__ecsSmokeMemory;
            if (!memory) return [];
            const bytes = new Uint8Array(memory.buffer),
              view = new DataView(memory.buffer);
            const result: { offset: number; counter: number }[] = [];
            for (
              let offset = guestAddress;
              offset + 0x2004 < Math.min(bytes.length, 256 * 1024 * 1024);
              offset++
            ) {
              if (bytes[offset] !== needle[0] || bytes[offset + 1] !== needle[1]) continue;
              if (needle.every((value, index) => bytes[offset + index] === value))
                result.push({
                  offset,
                  counter: view.getUint32(offset - guestAddress + counterAddress, littleEndian),
                });
              if (result.length > 16) break;
            }
            return result;
          },
          { needle, guestAddress, counterAddress, littleEndian },
        );
      await expect.poll(async () => (await counters()).length).toBeGreaterThan(0);
      const before = await counters();
      await expect
        .poll(async () => {
          const after = await counters();
          return after.some((next) =>
            before.some(
              (previous) => previous.offset === next.offset && previous.counter !== next.counter,
            ),
          );
        })
        .toBe(true);
      let image = Buffer.alloc(0),
        pixel: number[] = [];
      await expect
        .poll(
          async () => {
            image = await page.frameLocator('iframe').locator('canvas').screenshot();
            pixel = centerPixel(image);
            return pixel[1];
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThan(150);
      expect(pixel[1]).toBeGreaterThan(150);
      expect(pixel[0]).toBeLessThan(30);
      expect(pixel[2]).toBeLessThan(30);
      await mkdir(testInfo.outputDir, { recursive: true });
      const picture = testInfo.outputPath('real-jaguar-original-green.png');
      await writeFile(picture, image);
      await testInfo.attach('real-jaguar-original-green', {
        path: picture,
        contentType: 'image/png',
      });
      expect(errors).toEqual([]);
      await writeFile(
        testInfo.outputPath('real-jaguar-results.json'),
        JSON.stringify(
          {
            profile: (await client.playerProfiles()).items[0],
            browser: browser.version(),
            originalProgramSha256: createHash('sha256').update(program).digest('hex'),
            counters: await counters(),
            pixel,
            errors,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      await mkdir(testInfo.outputDir, { recursive: true });
      await page
        .screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true })
        .catch(() => {});
      console.log(
        'Additional core failure:',
        await page
          .locator('main')
          .textContent()
          .catch(() => 'unavailable'),
        errors,
        messages.slice(-60),
      );
      throw error;
    } finally {
      await page.goto('about:blank');
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
