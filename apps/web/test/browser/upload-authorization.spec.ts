import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openAddContent, signIn, test } from './fixture';

const generated = (name: string) => ({
  name,
  mimeType: 'application/octet-stream',
  buffer: Buffer.from([1, 2, 3, 4]),
});
for (const phase of ['review', 'reconciliation']) {
  for (const status of [401, 403]) {
    test(`${phase} picker ${status} on Next removes private targets and rejects upload access immediately`, async ({
      page,
      fixture,
    }) => {
      let denied = false;
      let accessReads = 0;
      await page.route('**/api/v1/browse-libraries', async (route) => {
        accessReads++;
        const response = await route.fetch();
        if (!denied || status === 401) return route.fulfill({ response });
        const listing = await response.json();
        for (const item of listing.items) item.canCreateItems = false;
        await route.fulfill({ json: listing });
      });
      await page.route('**/api/v1/items?**', async (route) => {
        if (new URL(route.request().url()).searchParams.has('cursor')) {
          denied = true;
          await route.fulfill({
            status,
            json: { type: 'urn:ecs:problem:forbidden', title: 'Target access rejected', status },
          });
        } else await route.continue();
      });
      if (phase === 'reconciliation')
        await page.route('**/api/v1/items', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          await route.fetch();
          await route.abort('failed');
        });
      await signIn(page, fixture);
      await page.getByRole('button', { name: 'Arcade', exact: true }).click();
      if (phase === 'review') await page.getByRole('tab', { name: 'Saves', exact: true }).click();
      await openAddContent(page, 'Upload files');
      const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
      await dialog
        .getByLabel('File', { exact: true })
        .setInputFiles(generated(phase === 'review' ? 'private.sav' : 'uncertain.nes'));
      if (phase === 'review')
        await dialog
          .getByRole('button', { name: 'Choose target for associated files', exact: true })
          .click();
      else {
        await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
        await dialog.getByRole('button', { name: 'Reconcile uncertain.nes', exact: true }).click();
      }
      const picker = dialog.getByRole('region', { name: 'Choose managed item', exact: true });
      await expect(picker.getByRole('button').filter({ hasText: '· ID ' })).toHaveCount(50);
      const baseline = accessReads;
      await picker.getByRole('button', { name: 'Next items', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(page.getByRole('button').filter({ hasText: '· ID ' })).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Retry unfinished uploads', exact: true }),
      ).toHaveCount(0);
      if (status === 403) {
        await expect.poll(() => accessReads).toBeGreaterThan(baseline);
        await page.getByRole('button', { name: /^Add (games|files)$/ }).click();
        await expect(
          page
            .getByRole('dialog', { name: /^Add (games|files)$/ })
            .getByRole('button', { name: 'Upload files', exact: true }),
        ).toHaveCount(0);
      } else
        await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
    });
  }
}
test('queue 403 closes private upload immediately and revalidates creation permission before later uploads', async ({
  page,
  fixture,
}) => {
  let denied = false;
  let opens = 0;
  let accessReads = 0;
  let creates = 0;
  await page.route('**/api/v1/browse-libraries', async (route) => {
    accessReads++;
    const response = await route.fetch();
    const listing = await response.json();
    if (denied) for (const item of listing.items) item.canCreateItems = false;
    await route.fulfill({ json: listing });
  });
  await page.route('**/api/v1/items', async (route) => {
    if (route.request().method() === 'POST') creates++;
    await route.continue();
  });
  await page.route('**/api/v1/uploads', async (route) => {
    opens++;
    denied = true;
    await route.fulfill({
      status: 403,
      json: { type: 'urn:ecs:problem:forbidden', title: 'Upload access rejected', status: 403 },
    });
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await openAddContent(page, 'Upload files');
  const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await dialog
    .getByLabel('File', { exact: true })
    .setInputFiles([generated('first.nes'), generated('later.nes')]);
  const baseline = accessReads;
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Retry unfinished uploads', exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => accessReads).toBeGreaterThan(baseline);
  await page.getByRole('button', { name: 'Add games', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Add games', exact: true })
      .getByRole('button', { name: 'Upload files', exact: true }),
  ).toHaveCount(0);
  expect(opens).toBe(1);
  expect(creates).toBe(1);
});
test('Games folder upload keeps saves associated with an explicit target instead of creating ROM items', async ({
  page,
  fixture,
}) => {
  const folder = join(fixture.directory, 'Mixed device folder');
  await mkdir(folder);
  await Promise.all(
    ['Mixed game.nes', 'Progress.sav', 'Progress.state'].map((name) =>
      writeFile(join(folder, name), Buffer.from([1, 2, 3, 4])),
    ),
  );
  let creates = 0;
  await page.route('**/api/v1/items', async (route) => {
    if (route.request().method() === 'POST') creates++;
    await route.continue();
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await openAddContent(page, 'Upload folder');
  const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await dialog.getByLabel('Folder', { exact: true }).setInputFiles(folder);
  await dialog
    .getByRole('combobox', { name: 'System', exact: true })
    .selectOption('com.provenance.nes');
  await expect(
    dialog.getByRole('combobox', { name: 'Kind for Progress.sav', exact: true }),
  ).toHaveValue('battery_save');
  await expect(
    dialog.getByRole('combobox', { name: 'Kind for Progress.state', exact: true }),
  ).toHaveValue('save_state');
  await expect(dialog.getByRole('button', { name: 'Upload', exact: true })).toBeDisabled();
  await dialog
    .getByRole('button', { name: 'Choose target for associated files', exact: true })
    .click();
  const target = dialog.getByRole('button', { name: new RegExp(`ID ${fixture.game.id}$`) });
  const listed = dialog.getByRole('button').filter({ hasText: '· ID ' });
  await expect(listed.first()).toBeEnabled();
  // Managed targets are bounded and sorted by random IDs, so this game can be on any page.
  for (let pageIndex = 0; pageIndex < 3 && !(await target.count()); pageIndex++) {
    const loaded = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v1/items',
    );
    await dialog.getByRole('button', { name: 'Next items', exact: true }).click();
    await loaded;
    await expect(listed.first()).toBeEnabled();
  }
  await target.click();
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog.getByText('3 succeeded · 0 unfinished')).toBeVisible();
  expect(creates).toBe(1);
  const manifest = await fixture.client.manifest(fixture.game.id);
  expect(
    manifest.files.some(
      (file) =>
        file.kind === 'battery_save' && file.relativePath === 'Mixed device folder/Progress.sav',
    ),
  ).toBeTruthy();
  expect(
    manifest.files.some(
      (file) =>
        file.kind === 'save_state' && file.relativePath === 'Mixed device folder/Progress.state',
    ),
  ).toBeTruthy();
});
