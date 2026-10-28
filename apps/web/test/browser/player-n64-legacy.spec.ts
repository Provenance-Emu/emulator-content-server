/** Opt-in real N64 homebrew acceptance; content always comes from an operator-local file. */
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { ContentClient } from '@ecs/client';
import { expect, test } from '@playwright/test';
import { openServer } from '../../../server/dist/src/index.js';

function pixels(png: Buffer): Uint8Array {
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20),
    channels = png[25] === 2 ? 3 : png[25] === 6 ? 4 : 0;
  if (png[24] !== 8 || !channels) throw Error('Unsupported PNG');
  const chunks: Buffer[] = [];
  for (let at = 8; at + 12 <= png.length; ) {
    const size = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT')
      chunks.push(png.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const bytes = inflateSync(Buffer.concat(chunks)),
    stride = width * channels,
    out = new Uint8Array(width * height * 3);
  let previous = Buffer.alloc(stride),
    offset = 0;
  for (let y = 0; y < height; y++) {
    const filter = bytes[offset++],
      row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = row[x - channels] ?? 0,
        b = previous[x] ?? 0,
        c = previous[x - channels] ?? 0,
        p = a + b - c,
        pa = Math.abs(p - a),
        pb = Math.abs(p - b),
        pc = Math.abs(p - c),
        paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
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
      if (!Number.isFinite(pred)) throw Error('Unsupported PNG filter');
      row[x] = ((bytes[offset++] ?? 0) + pred) & 255;
    }
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) out[(y * width + x) * 3 + c] = row[x * channels + c] ?? 0;
    previous = row;
  }
  return out;
}
function colorCount(bytes: Uint8Array): number {
  const colors = new Set<number>();
  for (let at = 0; at < bytes.length; at += 3)
    colors.add(((bytes[at] ?? 0) << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0));
  return colors.size;
}
function changedPixels(before: Uint8Array, after: Uint8Array): number {
  if (before.length !== after.length) return Number.MAX_SAFE_INTEGER;
  let changed = 0;
  for (let at = 0; at < before.length; at += 3)
    if (
      Math.abs((before[at] ?? 0) - (after[at] ?? 0)) +
        Math.abs((before[at + 1] ?? 0) - (after[at + 1] ?? 0)) +
        Math.abs((before[at + 2] ?? 0) - (after[at + 2] ?? 0)) >
      30
    )
      changed++;
  return changed;
}
const plugin = process.env.ECS_ACCEPTANCE_N64_PLUGIN,
  content = process.env.ECS_ACCEPTANCE_N64_CONTENT;
if (plugin && content) test.use({ headless: process.env.ECS_ACCEPTANCE_HEADLESS === '1' });
test('real legacy N64 core renders operator homebrew and responds to controller input in the opaque player', async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    !plugin || !content,
    'Set ECS_ACCEPTANCE_N64_PLUGIN and ECS_ACCEPTANCE_N64_CONTENT to external operator-local paths.',
  );
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), 'ecs-real-n64-')),
    errors: string[] = [],
    messages: string[] = [];
  let server: Awaited<ReturnType<typeof openServer>> | undefined;
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  page.on('console', (message) => messages.push(message.text()));
  try {
    const registry = join(directory, 'players');
    await mkdir(registry);
    await cp(resolve(plugin ?? ''), join(registry, 'n64'), { recursive: true });
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
    const session = await client.bootstrap(secret, 'n64-owner', randomBytes(24).toString('hex'));
    const library = await client.createLibrary({ name: 'Operator N64 acceptance' });
    const item = await client.createItem({
      libraryId: library.id,
      title: 'Operator homebrew',
      systemIdentifier: 'com.provenance.n64',
      md5: null,
      crc: null,
    });
    if ((await stat(content ?? '')).blocks === 0)
      throw Error('Hydrate the operator-local N64 content before this opt-in test');
    const bytes = await readFile(content ?? '');
    const extension = extname(content ?? '')
      .slice(1)
      .toLowerCase();
    if (!['z64', 'n64', 'v64'].includes(extension))
      throw Error('N64 acceptance needs a single cartridge file');
    const asset = await client.upload({
      libraryId: library.id,
      itemId: item.id,
      kind: 'rom',
      displayName: `operator.${extension}`,
      relativePath: `operator.${extension}`,
      baseRevision: item.revision,
      body: new Uint8Array(bytes),
    });
    await page.addInitScript(
      ({ origin, session }) => {
        if (window === top && location.origin === origin)
          localStorage.setItem(
            `ecs.session:${encodeURIComponent(origin)}`,
            JSON.stringify(session),
          );
      },
      { origin, session },
    );
    await page.goto(
      `${origin}/play/?item=${item.id}&asset=${asset.id}&profile=org.libretro.parallel-n64`,
    );
    await expect(page.getByRole('combobox', { name: 'Emulator', exact: true })).toHaveValue(
      'org.libretro.parallel-n64',
    );
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(
      page.getByText('This emulator profile does not provide save synchronization.', {
        exact: true,
      }),
    ).toBeVisible({ timeout: 45000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    const canvas = page.frameLocator('iframe').locator('canvas');
    let before = Buffer.alloc(0);
    await expect
      .poll(
        async () => {
          before = await canvas.screenshot();
          return colorCount(pixels(before));
        },
        { timeout: 30000 },
      )
      .toBeGreaterThan(8);
    await writeFile(testInfo.outputPath('n64-before.png'), before);
    await canvas.click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    const menu = await canvas.screenshot();
    await writeFile(testInfo.outputPath('n64-menu.png'), menu);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(300);
    const after = await canvas.screenshot();
    await writeFile(testInfo.outputPath('n64-after-input.png'), after);
    const changed = changedPixels(pixels(menu), pixels(after));
    expect(changed).toBeGreaterThan(100);
    expect(errors).toEqual([]);
    await writeFile(
      testInfo.outputPath('n64-results.json'),
      JSON.stringify(
        {
          browser: browser.version(),
          profile: (await client.playerProfiles()).items[0],
          contentSha256: createHash('sha256').update(bytes).digest('hex'),
          beforeColors: colorCount(pixels(before)),
          menuColors: colorCount(pixels(menu)),
          afterColors: colorCount(pixels(after)),
          changedPixels: changed,
          errors,
          messages,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await page
      .screenshot({ path: testInfo.outputPath('n64-failure.png'), fullPage: true })
      .catch(() => {});
    console.log(
      'N64 failure',
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
