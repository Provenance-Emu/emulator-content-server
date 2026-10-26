import type { Page } from '@playwright/test';
import { expect, signIn, test } from './fixture';

async function fakeSavePicker(page: Page, mode: 'save' | 'cancel' | 'pending' = 'save') {
  await page.evaluate((mode) => {
    const state = {
      bytes: [] as number[],
      closed: 0,
      aborted: 0,
      opened: 0,
      selected: 0,
      name: '',
    };
    const writable = {
      async write(bytes: Uint8Array) {
        state.bytes.push(...bytes);
      },
      async truncate(size: number) {
        state.bytes.length = size;
      },
      async seek(offset: number) {
        if (offset !== 0) throw new Error('Unexpected test offset');
      },
      async close() {
        state.closed++;
      },
      async abort() {
        state.aborted++;
      },
    };
    let complete: (() => void) | undefined;
    Object.assign(window, {
      __saveDownload: state,
      __finishSavePicker: () => complete?.(),
      showSaveFilePicker: async ({ suggestedName }: { suggestedName: string }) => {
        state.selected++;
        state.name = suggestedName;
        if (mode === 'cancel')
          throw new DOMException('Generated picker cancellation', 'AbortError');
        if (mode === 'pending')
          await new Promise<void>((resolve) => {
            complete = resolve;
          });
        return {
          async createWritable() {
            state.opened++;
            return writable;
          },
        };
      },
    });
  }, mode);
}

async function saved(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __saveDownload: {
            bytes: number[];
            closed: number;
            aborted: number;
            opened: number;
            selected: number;
            name: string;
          };
        }
      ).__saveDownload,
  );
}

test('supported save picker streams authenticated game bytes to the chosen file without a blob download', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture, true);
  await page.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
  await fakeSavePicker(page);
  let blobDownload = false;
  page.on('download', () => {
    blobDownload = true;
  });
  await page.getByRole('button', { name: 'Download sample.nes', exact: true }).click();
  await expect.poll(async () => (await saved(page)).closed).toBe(1);
  expect(await saved(page)).toMatchObject({
    bytes: [1, 2, 3, 4],
    name: 'sample.nes',
    opened: 1,
    aborted: 0,
  });
  expect(blobDownload).toBe(false);
  await expect(
    page.getByRole('button', { name: 'Download sample.nes', exact: true }),
  ).toBeEnabled();
});

test('canceling a save destination makes no file request and leaves the game usable', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
  await fakeSavePicker(page, 'cancel');
  fixture.requests.length = 0;
  await page.getByRole('button', { name: 'Download sample.nes', exact: true }).click();
  await expect.poll(async () => (await saved(page)).selected).toBe(1);
  await expect(
    page.getByRole('button', { name: 'Download sample.nes', exact: true }),
  ).toBeEnabled();
  expect(
    fixture.requests.filter((request) => /^GET \/api\/v1\/files\/[^/]+\/content$/.test(request)),
  ).toHaveLength(0);
  expect(await saved(page)).toMatchObject({ closed: 0, opened: 0 });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('leaving a game while its save picker is open cannot start a stale download or create a destination', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
  await fakeSavePicker(page, 'pending');
  fixture.requests.length = 0;
  await page.getByRole('button', { name: 'Download sample.nes', exact: true }).click();
  await expect.poll(async () => (await saved(page)).selected).toBe(1);
  await page.getByRole('button', { name: 'Back to collection', exact: true }).click();
  await page.evaluate(() =>
    (window as unknown as { __finishSavePicker: () => void }).__finishSavePicker(),
  );
  await expect(page.getByRole('button', { name: 'Open Game 000', exact: true })).toBeVisible();
  // Let the stale async picker continuation settle before checking network and filesystem boundaries.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  expect(await saved(page)).toMatchObject({ opened: 0, closed: 0 });
  expect(
    fixture.requests.filter((request) => /^GET \/api\/v1\/files\/[^/]+\/content$/.test(request)),
  ).toHaveLength(0);
});

for (const status of [401, 403])
  test(`streamed download ${status} aborts the chosen destination without committing a file`, async ({
    page,
    fixture,
  }) => {
    await signIn(page, fixture);
    await page.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
    await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
    await fakeSavePicker(page);
    await page.route('**/api/v1/files/*/content', (route) =>
      route.fulfill({
        status,
        json: { type: 'about:blank', title: 'Generated access rejection', status },
      }),
    );
    await page.getByRole('button', { name: 'Download sample.nes', exact: true }).click();
    await expect.poll(async () => (await saved(page)).aborted).toBe(1);
    expect(await saved(page)).toMatchObject({ closed: 0, bytes: [] });
    if (status === 401)
      await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    else await expect(page.getByRole('heading', { name: 'Game 000', exact: true })).toHaveCount(0);
  });

test('a browser without direct saving explains a large download before requesting bytes', async ({
  page,
  fixture,
}) => {
  await page.route('**/api/v1/items/*/manifest', async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    manifest.files.find((file: { kind: string }) => file.kind === 'rom').size =
      256 * 1024 * 1024 + 1;
    await route.fulfill({ json: manifest });
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
  fixture.requests.length = 0;
  await page.getByRole('button', { name: 'Download sample.nes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('256 MB');
  await expect(page.getByRole('alert')).toContainText('Chrome or Edge');
  expect(
    fixture.requests.filter((request) => /^GET \/api\/v1\/files\/[^/]+\/content$/.test(request)),
  ).toHaveLength(0);
  await expect(
    page.getByRole('button', { name: 'Download sample.nes', exact: true }),
  ).toBeEnabled();
});
