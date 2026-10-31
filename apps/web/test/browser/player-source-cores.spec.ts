/** Opt-in real-content acceptance. No firmware, games or captures are tracked. */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContentClient } from '@ecs/client';
import { expect, type Frame, test } from '@playwright/test';
import { openServer } from '../../../server/dist/src/index.js';

interface Input {
  id: string;
  system: string;
  package: string;
  content: string;
  extension: string;
  firmware?: Record<string, string>;
  kind:
    | 'megaduck-original'
    | 'pokemini-original'
    | 'pokemini-owned'
    | 'pcfx-homebrew'
    | 'n64-original';
}
const inputs: Input[] = process.env.ECS_ACCEPTANCE_SOURCE_CORES_JSON
  ? JSON.parse(readFileSync(process.env.ECS_ACCEPTANCE_SOURCE_CORES_JSON, 'utf8'))
  : [];
test.use({
  headless: true,
  actionTimeout: 15_000,
  launchOptions: { args: ['--mute-audio', '--use-gl=angle', '--use-angle=swiftshader'] },
});

async function capturePng(frame: Frame) {
  return Buffer.from(
    await frame.evaluate(async () => [
      ...new Uint8Array(
        await (
          globalThis as unknown as { __ecsSourceCapture(): Promise<ArrayBuffer> }
        ).__ecsSourceCapture(),
      ),
    ]),
  );
}

async function picture(frame: Frame) {
  return frame.evaluate(async () => {
    const hook = globalThis as unknown as { __ecsSourceCapture(): Promise<ArrayBuffer> };
    const bytes = await hook.__ecsSourceCapture();
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('Capture canvas unavailable');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4)
      colors.add(((pixels[i] ?? 0) << 16) | ((pixels[i + 1] ?? 0) << 8) | (pixels[i + 2] ?? 0));
    const center = [...ctx.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data];
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
    const titlePixels = ctx.getImageData(0, 0, canvas.width, Math.max(1, canvas.height >> 2)).data;
    const titleDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', titlePixels))]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
    return {
      width: canvas.width,
      height: canvas.height,
      colors: colors.size,
      center,
      digest,
      titleDigest,
    };
  });
}

async function stableMonoPicture(frame: Frame) {
  let last = await picture(frame),
    stable = 0;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const next = await picture(frame);
    stable = next.center.every((value, i) => Math.abs(value - (last.center[i] ?? 0)) <= 2)
      ? stable + 1
      : 0;
    last = next;
    if (stable >= 3) return last;
  }
  throw Error('Original program display did not settle');
}

for (const short of ['pokemini', 'sameduck', 'mednafen-pcfx', 'mupen64plus-next']) {
  test(`${short} boots content through authenticated playback and receives native controls`, async ({
    page,
    browser,
  }, testInfo) => {
    const input = inputs.find((i) => i.id === `org.libretro.${short}`);
    test.skip(!input, 'Provide an external acceptance input manifest for this core.');
    if (!input) return;
    const monoOriginal = input.kind === 'megaduck-original' || input.kind === 'pokemini-original';
    test.setTimeout(150_000);
    const directory = await mkdtemp(join(tmpdir(), 'ecs-source-core-'));
    const errors: string[] = [];
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.text().startsWith('ECS acceptance error:')) runtimeErrors.push(message.text());
    });
    let server: Awaited<ReturnType<typeof openServer>> | undefined;
    try {
      server = await openServer({
        dataDir: join(directory, 'data'),
        uiDir: resolve('dist'),
        localTrust: false,
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
      await client.installPlayerPackage(new Blob([new Uint8Array(await readFile(input.package))]));
      for (const [name, path] of Object.entries(input.firmware ?? {}))
        await client.installPlayerSystemFile(
          input.id,
          name,
          new Blob([new Uint8Array(await readFile(path))]),
        );
      const library = await client.createLibrary({ name: 'Isolated core acceptance' });
      const item = await client.createItem({
        libraryId: library.id,
        title: 'Private acceptance content',
        systemIdentifier: input.system,
        md5: null,
        crc: null,
      });
      const content = await readFile(input.content);
      const rom = await client.upload({
        libraryId: library.id,
        itemId: item.id,
        kind: 'rom',
        relativePath: `acceptance.${input.extension}`,
        displayName: `acceptance.${input.extension}`,
        baseRevision: item.revision,
        body: content,
      });
      await page.addInitScript(
        ({ origin, session }) => {
          if (location.origin === origin && window === top)
            localStorage.setItem(
              `ecs.session:${encodeURIComponent(origin)}`,
              JSON.stringify(session),
            );
        },
        { origin, session },
      );
      // Test-only hooks read actual captures/input and turn audio off BEFORE main.
      // The private port, opaque origin, CSP, emulator code and rendering are unchanged.
      await page.route('**/play/sandbox.html*', async (route) => {
        const response = await route.fetch();
        let body = await response.text();
        body = body.replace(
          'async function operation(message) {',
          'globalThis.__ecsSourceStats=()=>({input:inputAdapter?.info()});globalThis.__ecsSourceCapture=()=>capture();async function operation(message) {',
        );
        body = body.replace(
          'catch { if (!closed) port.postMessage',
          "catch(error) { console.error('ECS acceptance error:',message.op,String(error?.stack??error));globalThis.__ecsSourceError=String(error?.stack??error);if (!closed) port.postMessage",
        );
        if (!body.includes('await runtime.callMain(value);'))
          throw Error('Audio-off injection point missing; refusing to launch');
        body = body.replace(
          'await runtime.callMain(value);',
          "runtime.FS.writeFile('/ecs/retroarch.cfg',new TextEncoder().encode(new TextDecoder().decode(runtime.FS.readFile('/ecs/retroarch.cfg'))+'\\naudio_enable = \"false\"\\n'));await runtime.callMain(value);",
        );
        await route.fulfill({ response, body });
      });
      await page.goto(`${origin}/play/?item=${item.id}&asset=${rom.id}&profile=${input.id}`);
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(
        page
          .getByRole('button', { name: 'Back to game', exact: true })
          .or(page.getByRole('alert'))
          .first(),
      ).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('alert')).toHaveCount(0);
      const frame = await expect
        .poll(() =>
          page
            .frames()
            .find((f) => f.url().includes('/play/sandbox.html'))
            ?.url(),
        )
        .not.toBeUndefined()
        .then(() => page.frames().find((f) => f.url().includes('/play/sandbox.html')));
      if (!frame) throw Error('Player frame unavailable');
      const stats = () =>
        frame.evaluate(() =>
          (
            globalThis as unknown as {
              __ecsSourceStats(): {
                input: { supported: boolean; ready: boolean; states: { buttons: number }[] };
              };
            }
          ).__ecsSourceStats(),
        );
      await expect.poll(async () => (await stats()).input?.ready).toBe(true);
      await expect
        .poll(
          async () => {
            try {
              return (await picture(frame)).width;
            } catch {
              return 0;
            }
          },
          { timeout: 30_000 },
        )
        .toBeGreaterThan(0);
      if (input.kind === 'pcfx-homebrew') await page.waitForTimeout(12_000);
      let before = await picture(frame);
      if (monoOriginal) {
        await expect
          .poll(async () => (await picture(frame)).center.slice(0, 3).reduce((a, b) => a + b, 0))
          .toBeGreaterThan(100);
      } else {
        await expect
          .poll(async () => (await picture(frame)).colors, { timeout: 45_000 })
          .toBeGreaterThan(1);
      }
      before = await picture(frame);
      if (monoOriginal) before = await stableMonoPicture(frame);
      if (input.kind === 'n64-original')
        await expect
          .poll(
            async () => {
              const p = (await picture(frame)).center;
              return (p[1] ?? 0) - (p[2] ?? 0);
            },
            { timeout: 15_000 },
          )
          .toBeGreaterThan(30);
      if (input.kind === 'pcfx-homebrew') {
        await mkdir(testInfo.outputDir, { recursive: true });
        await writeFile(testInfo.outputPath('title.png'), await capturePng(frame));
      }
      await page.getByRole('button', { name: 'Back to game', exact: true }).click();
      await frame.locator('canvas').click();
      await expect.poll(() => frame.evaluate(() => document.activeElement?.id)).toBe('canvas');
      const key =
        input.kind === 'pcfx-homebrew' ? 'Enter' : input.kind === 'n64-original' ? 'z' : 'x';
      const buttonMask =
        input.kind === 'pcfx-homebrew' ? 8 : input.kind === 'n64-original' ? 1 : 256;
      await page.keyboard.down(key);
      await expect
        .poll(async () => ((await stats()).input.states[0]?.buttons ?? 0) & buttonMask)
        .toBe(buttonMask);
      if (monoOriginal)
        await expect
          .poll(async () => (await picture(frame)).center.slice(0, 3).reduce((a, b) => a + b, 0))
          .toBeLessThan(before.center.slice(0, 3).reduce((a, b) => a + b, 0) - 50);
      else if (input.kind === 'n64-original')
        await expect
          .poll(
            async () => {
              const p = (await picture(frame)).center;
              return (p[2] ?? 0) - (p[1] ?? 0);
            },
            { timeout: 15_000 },
          )
          .toBeGreaterThan(30);
      else if (input.kind === 'pcfx-homebrew')
        await expect
          .poll(async () => (await picture(frame)).titleDigest, { timeout: 15_000 })
          .not.toBe(before.titleDigest);
      else
        await expect
          .poll(async () => (await picture(frame)).digest, { timeout: 15_000 })
          .not.toBe(before.digest);
      const pressed = monoOriginal ? await stableMonoPicture(frame) : await picture(frame);
      await page.keyboard.up(key);
      await expect.poll(async () => (await stats()).input.states[0]?.buttons ?? 0).toBe(0);
      if (monoOriginal)
        await expect
          .poll(async () => (await picture(frame)).center.slice(0, 3).reduce((a, b) => a + b, 0))
          .toBeGreaterThan(pressed.center.slice(0, 3).reduce((a, b) => a + b, 0) + 50);
      if (input.kind === 'n64-original')
        await expect
          .poll(
            async () => {
              const p = (await picture(frame)).center;
              return (p[1] ?? 0) - (p[2] ?? 0);
            },
            { timeout: 15_000 },
          )
          .toBeGreaterThan(30);
      expect(errors).toEqual([]);
      await mkdir(testInfo.outputDir, { recursive: true });
      await writeFile(testInfo.outputPath('frame.png'), await capturePng(frame));
      await writeFile(
        testInfo.outputPath('acceptance.json'),
        JSON.stringify(
          {
            id: input.id,
            browser: browser.version(),
            kind: input.kind,
            contentBytes: content.length,
            contentSha256: createHash('sha256').update(content).digest('hex'),
            firmwareSupplied: Object.keys(input.firmware ?? {}),
            before,
            pressed,
            after: await picture(frame),
            errors,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      const frame = page.frames().find((f) => f.url().includes('/play/sandbox.html'));
      const detail = frame
        ? await frame
            .evaluate(
              () => (globalThis as unknown as { __ecsSourceError?: string }).__ecsSourceError,
            )
            .catch(() => 'frame closed')
        : undefined;
      if (frame) {
        await mkdir(testInfo.outputDir, { recursive: true });
        await capturePng(frame)
          .then((bytes) => writeFile(testInfo.outputPath('failure-frame.png'), bytes))
          .catch(() => {});
      }
      console.error('Core acceptance failed', {
        id: input.id,
        alerts: await page.getByRole('alert').allTextContents(),
        logs: await page.locator('.player-log').allTextContents(),
        detail,
        runtimeErrors,
      });
      throw error;
    } finally {
      await page.goto('about:blank').catch(() => {});
      await server?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
