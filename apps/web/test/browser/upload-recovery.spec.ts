import { expect, signIn, test } from './fixture';

test('uploads work on an ordinary LAN HTTP origin without randomUUID', async ({
  page,
  fixture,
}) => {
  const origin = 'http://ecs-upload.invalid';
  await page.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await route.fetch({ url: fixture.origin + url.pathname + url.search }),
    });
  });
  await page.addInitScript(
    ({ origin, session }) => {
      localStorage.setItem(`ecs.session:${encodeURIComponent(origin)}`, JSON.stringify(session));
    },
    { origin, session: fixture.session },
  );
  await page.goto(`${origin}/ui/`);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await page.getByRole('button', { name: 'Upload files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload files' });
  await dialog.getByLabel('File', { exact: true }).setInputFiles({
    name: 'LAN game.nes',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([1, 2, 3, 4]),
  });
  await dialog
    .getByRole('combobox', { name: 'System', exact: true })
    .selectOption('com.provenance.nes');
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Open LAN game', exact: true })).toBeVisible();
});

test('retrying a failed upload retains its created game and transfer key', async ({
  page,
  fixture,
}) => {
  let creations = 0;
  const keys: string[] = [];
  let fail = true;
  await page.route('**/api/v1/items', async (route) => {
    if (route.request().method() === 'POST') creations++;
    await route.continue();
  });
  await page.route('**/api/v1/uploads', async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (fail)
      await route.fulfill({
        status: 503,
        json: {
          type: 'urn:ecs:problem:unavailable',
          title: 'Generated upload outage',
          status: 503,
        },
      });
    else await route.continue();
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await page.getByRole('button', { name: 'Upload files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload files' });
  await dialog.getByLabel('File', { exact: true }).setInputFiles({
    name: 'Retry game.nes',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([1, 2, 3, 4]),
  });
  await dialog
    .getByRole('combobox', { name: 'System', exact: true })
    .selectOption('com.provenance.nes');
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog.getByText('Generated upload outage', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('File', { exact: true })).toBeDisabled();
  await expect(dialog.getByRole('combobox', { name: 'System', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toBeDisabled();
  fail = false;
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(creations).toBe(1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  await expect(page.getByRole('button', { name: 'Open Retry game', exact: true })).toHaveCount(1);
});

test('a lost game-creation response requires checking the library rather than blindly creating again', async ({
  page,
  fixture,
}) => {
  let creations = 0;
  await page.route('**/api/v1/items', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    creations++;
    await route.fetch();
    await route.abort('failed');
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await page.getByRole('button', { name: 'Upload files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload files' });
  await dialog.getByLabel('File', { exact: true }).setInputFiles({
    name: 'Uncertain game.nes',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([5, 6, 7, 8]),
  });
  await dialog
    .getByRole('combobox', { name: 'System', exact: true })
    .selectOption('com.provenance.nes');
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Upload', exact: true })).toBeDisabled();
  await expect(dialog.getByText(/may have created this game/)).toBeVisible();
  expect(creations).toBe(1);
  await dialog.getByRole('button', { name: 'Close Upload files', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('button', { name: 'Open Uncertain game', exact: true }).click();
  await page.getByRole('button', { name: 'Add a file', exact: true }).click();
  const existing = page.getByRole('dialog', { name: 'Add a file', exact: true });
  await existing.getByLabel('File', { exact: true }).setInputFiles({
    name: 'Uncertain game.nes',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([5, 6, 7, 8]),
  });
  await existing.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(existing).not.toBeVisible();
  expect(creations).toBe(1);
});

test('manual retry replays a committed upload after all completion responses were lost', async ({
  page,
  fixture,
}) => {
  const completionKeys: string[] = [];
  let loseResponses = true;
  let creations = 0;
  await page.route('**/api/v1/items', async (route) => {
    if (route.request().method() === 'POST') creations++;
    await route.continue();
  });
  await page.route('**/api/v1/uploads/*/complete', async (route) => {
    completionKeys.push(route.request().headers()['idempotency-key'] ?? '');
    if (!loseResponses) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort('failed');
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await page.getByRole('button', { name: 'Upload files', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload files' });
  await dialog.getByLabel('File', { exact: true }).setInputFiles({
    name: 'Committed game.nes',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([1, 2, 3, 4]),
  });
  await dialog
    .getByRole('combobox', { name: 'System', exact: true })
    .selectOption('com.provenance.nes');
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog.getByText(/Retry uses the same game and file/)).toBeVisible();
  expect(completionKeys).toHaveLength(3);
  loseResponses = false;
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(creations).toBe(1);
  expect(completionKeys).toHaveLength(4);
  expect(new Set(completionKeys).size).toBe(1);
  const result = await fixture.client.browse({ libraryId: fixture.empty.id, category: 'games' });
  expect(result.items).toHaveLength(1);
  const manifest = await fixture.client.manifest(result.items[0]?.id ?? 'missing');
  expect(manifest.files).toHaveLength(1);
});
