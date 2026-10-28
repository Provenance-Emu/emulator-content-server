import { expect, openAddContent, signIn, test } from './fixture';

const generated = (name = 'Recover game.nes', values = [1, 2, 3, 4]) => ({
  name,
  mimeType: 'application/octet-stream',
  buffer: Buffer.from(values),
});

test('saved queue survives reload, rejects changed files and resumes the same transfer without another game', async ({
  page,
  fixture,
}) => {
  let creates = 0;
  let fail = true;
  const keys: string[] = [];
  await page.route('**/api/v1/items', async (route) => {
    if (route.request().method() === 'POST') creates++;
    await route.continue();
  });
  await page.route('**/api/v1/uploads', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (fail)
      await route.fulfill({
        status: 503,
        json: { type: 'about:blank', title: 'Generated upload outage', status: 503 },
      });
    else await route.continue();
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await openAddContent(page);
  let dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await dialog.getByLabel('File', { exact: true }).setInputFiles(generated());
  await dialog
    .getByRole('checkbox', { name: 'Save upload progress on this device', exact: true })
    .check();
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog.getByText('Generated upload outage', { exact: true })).toBeVisible();
  expect(creates).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await openAddContent(page);
  dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await expect(
    dialog.getByRole('heading', { name: 'Unfinished uploads found', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Recover uploads', exact: true }).click();
  fixture.requests.length = 0;
  await dialog
    .getByLabel('Reselect files', { exact: true })
    .setInputFiles(generated('Recover game.nes', [4, 3, 2, 1]));
  await expect(
    dialog.getByText('File contents do not match the saved upload. Select the original file.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(fixture.requests.filter((request) => request.startsWith('POST '))).toHaveLength(0);
  await dialog.getByLabel('Reselect files', { exact: true }).setInputFiles(generated());
  fail = false;
  await dialog.getByRole('button', { name: 'Retry unfinished uploads', exact: true }).click();
  await expect(dialog.getByText('1 succeeded · 0 unfinished', { exact: true })).toBeVisible();
  expect(creates).toBe(1);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  expect((await fixture.client.items({ libraryId: fixture.empty.id })).items).toHaveLength(1);
});

test('signing out clears saved upload metadata before another account can open uploads', async ({
  page,
  fixture,
}) => {
  await page.route('**/api/v1/uploads', (route) =>
    route.fulfill({
      status: 503,
      json: { type: 'about:blank', title: 'Generated outage', status: 503 },
    }),
  );
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await openAddContent(page);
  const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await dialog.getByLabel('File', { exact: true }).setInputFiles(generated());
  await dialog
    .getByRole('checkbox', { name: 'Save upload progress on this device', exact: true })
    .check();
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog.getByText('Generated outage', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close Upload files', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const r = indexedDB.open('ecs-upload-progress-v1', 1);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        try {
          return await new Promise<number>((resolve, reject) => {
            const r = db.transaction('queues').objectStore('queues').count();
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
        } finally {
          db.close();
        }
      }),
    )
    .toBe(0);
});

test('blocked local storage still allows an explicitly chosen temporary upload queue', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await page.evaluate(() =>
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: {
        open() {
          throw new DOMException('Generated storage denial', 'SecurityError');
        },
      },
    }),
  );
  await openAddContent(page);
  const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await expect(dialog.getByRole('alert')).toContainText('Saved upload progress could not be read');
  await dialog.getByRole('button', { name: 'Start a temporary queue', exact: true }).click();
  await dialog.getByLabel('File', { exact: true }).setInputFiles(generated());
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog.getByText('1 succeeded · 0 unfinished', { exact: true })).toBeVisible();
});

test('logout stays immediate and reports a failed local recovery-data cleanup', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.evaluate(() =>
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: {
        open() {
          throw new DOMException('Generated storage denial', 'SecurityError');
        },
      },
    }),
  );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'Saved upload progress could not be checked or cleared',
  );
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
});
