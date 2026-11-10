/** Opt-in acceptance for the exact official Nestopia bytes in the ECS catalog. */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContentClient } from '@ecs/client';
import { expect, test } from '@playwright/test';
import { openServer } from '../../../server/dist/src/index.js';

const profileId = 'org.libretro.nestopia';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Wrap the fixture's 16 KiB PRG and 8 KiB CHR in an NROM-128 UNIF image. */
function unifFromFixture(ines: Buffer): Buffer {
  expect(ines.subarray(0, 7)).toEqual(Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, 2]));
  expect(ines.length).toBe(16 + 16_384 + 8192);
  function chunk(name: string, bytes: Buffer) {
    const header = Buffer.alloc(8);
    header.write(name, 0, 4, 'ascii');
    header.writeUInt32LE(bytes.length, 4);
    return Buffer.concat([header, bytes]);
  }
  const header = Buffer.alloc(32);
  header.write('UNIF', 'ascii');
  header.writeUInt32LE(7, 4);
  const prgEnd = 16 + 16_384;
  return Buffer.concat([
    header,
    chunk('MAPR', Buffer.from('NES-NROM-128\0')),
    chunk('MIRR', Buffer.from([0])),
    chunk('PRG0', ines.subarray(16, prgEnd)),
    chunk('CHR0', ines.subarray(prgEnd)),
  ]);
}

function assemble(directory: string, stem: string, volatile = false): Buffer {
  const object = join(directory, `${stem}.o`);
  const program = join(directory, `${stem}.nes`);
  execFileSync('ca65', [
    ...(volatile ? ['-D', 'VOLATILE_COUNTER=1'] : []),
    resolve('../../examples/browser-playback/acceptance.s'),
    '-o',
    object,
  ]);
  execFileSync('ld65', [
    '-C',
    resolve('../../examples/browser-playback/nes.cfg'),
    object,
    '-o',
    program,
  ]);
  return readFileSync(program);
}

test.use({ headless: true, launchOptions: { args: ['--mute-audio'] } });

test('pinned upstream Nestopia installs, plays generated iNES and UNIF games with A input', async ({
  page,
  browser,
}, testInfo) => {
  test.skip(
    process.env.ECS_ACCEPTANCE_UPSTREAM_NES !== '1',
    'Opt in to official archive recovery.',
  );
  test.setTimeout(15 * 60_000);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ecs-upstream-nes-')));
  let server: Awaited<ReturnType<typeof openServer>> | undefined;
  try {
    const ines = assemble(directory, 'acceptance');
    expect(digest(ines)).toBe('52c6dee458ca323ab4284495321f633ceb60d8a85eb311f6fa562a83543d2c6f');
    const unif = unifFromFixture(assemble(directory, 'volatile', true));
    server = await openServer({
      dataDir: join(directory, 'data'),
      uiDir: resolve('dist'),
      automaticMatching: false,
      localTrust: false,
      logger: false,
    });
    const secret = randomBytes(32).toString('hex');
    server.catalog.saveBootstrapHash(digest(Buffer.from(secret)));
    const origin = await server.app.listen({ host: '127.0.0.1', port: 0 });
    const client = new ContentClient(origin);
    const session = await client.bootstrap(
      secret,
      'acceptance-owner',
      randomBytes(24).toString('hex'),
    );
    await client.installPlayer(profileId);
    const profile = await client.playerProfile(profileId);
    const { loader, wasm } = await client.playerProfileAssets(profileId);
    expect(profile.saveCompletion).toBe('none');
    expect(digest(loader.bytes)).toBe(
      '1256368b75e84c5c34ea741360fecc7d1709a2a3aba41ad1305ab040a4921627',
    );
    expect(digest(wasm.bytes)).toBe(
      '3ae618136aea28bd9a7b4abecfacda09ed9816766922d3444e4ac4d26b6c8a45',
    );
    const library = await client.createLibrary({ name: 'Generated NES acceptance' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ origin, session }) => {
        if (window === top && location.origin === origin) {
          localStorage.setItem(
            `ecs.session:${encodeURIComponent(origin)}`,
            JSON.stringify(session),
          );
        }
        // Disconnect the hardware output before any game starts. Observe only samples
        // that the unmodified core supplies to Web Audio.
        const connect = AudioNode.prototype.connect;
        Object.defineProperty(AudioNode.prototype, 'connect', {
          value(this: AudioNode, destination: AudioNode | AudioParam, ...indices: number[]) {
            if (destination instanceof AudioDestinationNode) return destination;
            return Reflect.apply(connect, this, [destination, ...indices]);
          },
        });
        const probe = { buffers: 0, peak: 0 };
        Object.assign(globalThis, { __ecsUpstreamAudio: probe });
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
          if (this.buffer) {
            probe.buffers++;
            for (const sample of this.buffer.getChannelData(0)) {
              probe.peak = Math.max(probe.peak, Math.abs(sample));
            }
          }
          return start.apply(this, args);
        };
      },
      { origin, session },
    );

    const formats: {
      extension: string;
      sizeBytes: number;
      sha256: string;
      renderedCanvas: { before: string; after: string };
      audio: { buffers: number; peak: number };
    }[] = [];
    for (const [extension, content] of [
      ['nes', ines],
      ['unif', unif],
      ['unf', unif],
    ] as const) {
      await test.step(`Play generated .${extension} content`, async () => {
        const item = await client.createItem({
          libraryId: library.id,
          title: `Original NES input program (${extension})`,
          systemIdentifier: 'com.provenance.nes',
          md5: null,
          crc: null,
        });
        const rom = await client.upload({
          libraryId: library.id,
          itemId: item.id,
          kind: 'rom',
          displayName: `acceptance.${extension}`,
          relativePath: `acceptance.${extension}`,
          baseRevision: item.revision,
          body: content,
        });
        await page.goto(`${origin}/play/?item=${item.id}&asset=${rom.id}&profile=${profileId}`);
        await expect(page.getByRole('combobox', { name: 'Emulator', exact: true })).toHaveValue(
          profileId,
        );
        await expect(
          page.getByText('This profile supports playback without synchronized saves.'),
        ).toBeVisible();
        await page.getByRole('button', { name: 'Start', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Back to game', exact: true })).toBeVisible({
          timeout: 45_000,
        });
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Save battery', exact: true })).toHaveCount(
          0,
        );
        await expect(page.getByRole('button', { name: 'Save state', exact: true })).toHaveCount(0);
        await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
        const frame = page
          .frames()
          .find((candidate) => candidate.url().includes('/play/sandbox.html'));
        if (!frame) throw new Error('Missing opaque player frame');
        const audio = () =>
          frame.evaluate(
            () =>
              (globalThis as unknown as { __ecsUpstreamAudio: { buffers: number; peak: number } })
                .__ecsUpstreamAudio,
          );
        await expect
          .poll(async () => (await audio()).peak, { timeout: 10_000 })
          .toBeGreaterThan(0.001);
        const canvas = frame.locator('canvas');
        await canvas.click();
        const before = digest(await canvas.screenshot());
        await page.keyboard.down('x');
        await page.waitForTimeout(125);
        await page.keyboard.up('x');
        await expect.poll(async () => digest(await canvas.screenshot())).not.toBe(before);
        const after = digest(await canvas.screenshot());
        const audioSamples = await audio();
        await page.getByRole('link', { name: 'Stop and return to library' }).click();
        await expect(page.locator('iframe')).toHaveCount(0);
        expect(errors).toEqual([]);
        formats.push({
          extension,
          sizeBytes: content.length,
          sha256: digest(content),
          renderedCanvas: { before, after },
          audio: audioSamples,
        });
      });
    }
    await writeFile(
      testInfo.outputPath('upstream-nestopia.json'),
      JSON.stringify(
        {
          profile,
          browser: browser.version(),
          platform: process.platform,
          arch: process.arch,
          formats,
          synchronizedSaves: 'disabled',
        },
        null,
        2,
      ),
    );
  } finally {
    await page.close().catch(() => {});
    await server?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
