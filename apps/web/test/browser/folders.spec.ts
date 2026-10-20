import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, signIn, test } from './fixture';

test.beforeEach(async ({ page, fixture }) => {
  // Keep the default server-directory view within this generated fixture as well.
  await page.route('**/api/v1/folders', async (route) => {
    await route.fulfill({
      response: await route.fetch({
        url: `${fixture.origin}/api/v1/folders?path=${encodeURIComponent(fixture.directory)}`,
      }),
    });
  });
});

test('library staging and Escape write nothing, preserve the edited name, and return focus', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  fixture.requests.length = 0;
  const add = page.getByRole('button', { name: 'Add library', exact: true });
  await add.click();
  const editor = page.getByRole('dialog', { name: 'Create library', exact: true });
  await editor.getByRole('button', { name: 'Select server folder' }).click();
  await editor
    .getByRole('textbox', { name: 'Server folder path', exact: true })
    .fill('/generated/Arcade');
  await editor.getByRole('button', { name: 'Select folder', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: 'Library name' })).toHaveValue('Arcade');
  await editor.getByRole('textbox', { name: 'Library name' }).fill('Personal');
  await expect(editor.getByText('/generated/Arcade', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(add).toBeFocused();
  expect(fixture.requests.filter((r) => r.startsWith('POST ') || r.startsWith('PUT '))).toEqual([]);
});

test('empty library creation selects the new library and rename refreshes navigation', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Add library', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Create library', exact: true });
  await editor.getByRole('textbox', { name: 'Library name' }).fill('New empty library');
  await editor.getByRole('button', { name: 'Create library', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New empty library', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Rename New empty library', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename library', exact: true });
  await rename.getByRole('textbox', { name: 'Library name' }).fill('Renamed library');
  await rename.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Renamed library', exact: true })).toBeVisible();
});

test('a delayed initial folder listing cannot replace an entered manual path', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/folders*', async (route) => {
    const response = await route.fetch({
      url: `${fixture.origin}/api/v1/folders?path=${encodeURIComponent(fixture.directory)}`,
    });
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Add folder to Arcade', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: 'Add library folder', exact: true });
  const path = chooser.getByRole('textbox', { name: 'Server folder path', exact: true });
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/folders');
  try {
    await path.fill('/manual/generated/path');
  } finally {
    release();
  }
  await (await response).finished();
  await expect(path).toHaveValue('/manual/generated/path');
});

test('a rejected reconciliation read immediately clears the library editor and signs out', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Add library', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Create library', exact: true });
  await editor.getByRole('textbox', { name: 'Library name' }).fill('Generated ambiguous create');
  await page.route('**/api/v1/libraries', (route) =>
    route.fulfill({ status: 503, json: { title: 'Response unavailable', status: 503 } }),
  );
  await editor.getByRole('button', { name: 'Create library', exact: true }).click();
  await expect(
    editor.getByRole('button', { name: 'Refresh existing libraries', exact: true }),
  ).toBeVisible();
  await page.route('**/api/v1/browse-libraries', (route) =>
    route.fulfill({ status: 401, json: { title: 'Access denied', status: 401 } }),
  );
  await editor.getByRole('button', { name: 'Refresh existing libraries', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(editor).toHaveCount(0);
});

test('Add folder registers in the chooser, preserves failed paths, and scan retry never registers twice', async ({
  page,
  fixture,
}) => {
  const folder = join(fixture.directory, 'New games');
  await mkdir(folder);
  await writeFile(join(folder, 'generated.nes'), new Uint8Array([78, 69, 83, 26]));
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  fixture.requests.length = 0;
  await page.getByRole('button', { name: 'Add folder to Arcade', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: 'Add library folder', exact: true });
  await chooser
    .getByRole('textbox', { name: 'Server folder path', exact: true })
    .fill('/missing/generated/path');
  await chooser.getByRole('button', { name: 'Add folder', exact: true }).click();
  await expect(chooser.getByRole('alert')).toBeVisible();
  await expect(
    chooser.getByRole('textbox', { name: 'Server folder path', exact: true }),
  ).toHaveValue('/missing/generated/path');
  await page.route('**/api/v1/roots/*/scan', (route) =>
    route.fulfill({ status: 503, json: { title: 'Scan unavailable', status: 503 } }),
  );
  await chooser.getByRole('textbox', { name: 'Server folder path', exact: true }).fill(folder);
  await chooser.getByRole('button', { name: 'Add folder', exact: true }).click();
  await expect(chooser).toHaveCount(0);
  await expect(page.getByText('Scan failed', { exact: true })).toBeVisible();
  const registrations = fixture.requests.filter((r) => r === 'POST /api/v1/roots').length;
  await page.unroute('**/api/v1/roots/*/scan');
  await page.getByRole('button', { name: 'Retry scan New games', exact: true }).click();
  await expect(page.getByText('Scan failed', { exact: true })).toHaveCount(0);
  expect(fixture.requests.filter((r) => r === 'POST /api/v1/roots').length).toBe(registrations);
  await page.getByRole('button', { name: 'View files in New games', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Arcade', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open generated.nes', exact: true })).toBeVisible();
});

test('server browsing final action registers once and disconnect confirms files stay on disk', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Add folder to Empty shelf', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: 'Add library folder', exact: true });
  await chooser
    .getByRole('textbox', { name: 'Server folder path', exact: true })
    .fill(fixture.directory);
  await chooser.getByRole('button', { name: 'Browse path', exact: true }).click();
  await expect(chooser.getByRole('button', { name: 'player', exact: true })).toBeVisible();
  await chooser.getByRole('button', { name: 'player', exact: true }).click();
  await chooser.getByRole('button', { name: 'Add folder', exact: true }).click();
  await expect(chooser).toHaveCount(0);
  await page.getByRole('button', { name: 'Disconnect player', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Disconnect folder', exact: true });
  await expect(confirm.getByText('Files stay on disk.', { exact: true })).toBeVisible();
  await confirm.getByRole('button', { name: 'Disconnect folder', exact: true }).click();
  await expect(page.getByText(join(fixture.directory, 'player'), { exact: true })).toHaveCount(0);
});

test('unassigned folders require explicit assignment with a permissions warning', async ({
  page,
  fixture,
}) => {
  const root = await fixture.legacy();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Assign External folder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Assign folder', exact: true });
  await expect(dialog.getByText(/library permissions/i)).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Library', exact: true })).toHaveValue('');
  await dialog
    .getByRole('combobox', { name: 'Library', exact: true })
    .selectOption(fixture.library.id);
  await dialog.getByRole('button', { name: 'Assign folder', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await fixture.client.rootSummaries({ libraryId: fixture.library.id })).items.some(
      (s) => s.root.id === root.id,
    ),
  ).toBe(true);
  expect(fixture.requests.some((r) => r === 'GET /api/v1/sources')).toBe(false);
});

test('Add destination retains the write target by default; explicit selection failure retries only selection', async ({
  page,
  fixture,
}) => {
  const folder = join(fixture.directory, 'Upload drive');
  await mkdir(folder);
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Upload storage', exact: true }).click();
  const add = page.getByRole('button', { name: 'Add destination', exact: true });
  await add.click();
  const chooser = page.getByRole('dialog', { name: 'Add upload destination', exact: true });
  await expect(
    chooser.getByRole('checkbox', { name: 'Make destination for new uploads' }),
  ).not.toBeChecked();
  await chooser.getByRole('textbox', { name: 'Server folder path', exact: true }).fill(folder);
  await chooser.getByRole('checkbox', { name: 'Make destination for new uploads' }).check();
  await page.route('**/api/v1/storage-locations/write-target', (route) =>
    route.fulfill({ status: 503, json: { title: 'Selection unavailable', status: 503 } }),
  );
  await chooser.getByRole('button', { name: 'Add destination', exact: true }).click();
  await expect(chooser.getByRole('alert')).toContainText('Selection unavailable');
  const registrations = fixture.requests.filter(
    (r) => r === 'POST /api/v1/storage-locations',
  ).length;
  await page.unroute('**/api/v1/storage-locations/write-target');
  await chooser.getByRole('button', { name: 'Add destination', exact: true }).click();
  await expect(chooser).toHaveCount(0);
  await expect(add).toBeFocused();
  expect(fixture.requests.filter((r) => r === 'POST /api/v1/storage-locations').length).toBe(
    registrations,
  );
  expect((await fixture.client.storageLocations()).writeLocationId).not.toBeNull();
});
