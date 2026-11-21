import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, openAddContent, signIn, test } from './fixture';

const generated = (name: string) => ({
  name,
  mimeType: 'application/octet-stream',
  buffer: Buffer.from([1, 2, 3, 4]),
});
test('folder review preserves relative paths and the queue retains successful results', async ({
  page,
  fixture,
}) => {
  const folder = join(fixture.directory, 'Device collection');
  await mkdir(join(folder, 'nested'), { recursive: true });
  await writeFile(join(folder, 'nested', 'Folder game.nes'), Buffer.from([1, 2, 3]));
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await openAddContent(page, 'Upload folder');
  const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await dialog.getByLabel('Folder', { exact: true }).setInputFiles(folder);
  await expect(
    dialog.getByText('Device collection/nested/Folder game.nes', { exact: false }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog.getByText('1 succeeded · 0 unfinished')).toBeVisible();
  const result = await fixture.client.items({ libraryId: fixture.empty.id });
  const manifest = await fixture.client.manifest(result.items[0]?.id ?? 'missing');
  expect(manifest.files[0]?.relativePath).toBe('Device collection/nested/Folder game.nes');
});
test('missing metadata blocks upload and unsupported folders explain the files fallback', async ({
  page,
  fixture,
}) => {
  await page.addInitScript(() => {
    delete (HTMLInputElement.prototype as unknown as Record<string, unknown>).webkitdirectory;
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await openAddContent(page, 'Upload files');
  const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await expect(dialog.getByText(/Folder selection is unavailable/)).toBeVisible();
  await dialog
    .getByLabel('File', { exact: true })
    .setInputFiles([generated('unknown.bin'), generated('another.bin')]);
  await expect(dialog.getByRole('button', { name: 'Upload', exact: true })).toBeDisabled();
  await dialog
    .getByRole('combobox', { name: 'System', exact: true })
    .selectOption('com.provenance.nes');
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog.getByText('2 succeeded · 0 unfinished')).toBeVisible();
});
test('large selections show fifty review entries and more as the list is scrolled', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await openAddContent(page, 'Upload files');
  const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await dialog.getByLabel('File', { exact: true }).evaluate((input) => {
    const data = new DataTransfer();
    for (let i = 0; i < 10000; i++)
      data.items.add(new File([new Uint8Array([1])], `game-${i}.nes`));
    (input as HTMLInputElement).files = data.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(dialog.locator('.upload-entries li')).toHaveCount(50);
  await expect(dialog.getByText('Showing 50 of 10,000', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^(Previous|Next) files$/ })).toHaveCount(0);
  // Reaching the end of the list adds the next fifty below the ones already there.
  await dialog
    .getByRole('button', { name: 'Show more files', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(dialog.getByText('Showing 100 of 10,000', { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole('textbox', { name: 'Title for game-0.nes', exact: true }),
  ).toHaveCount(1);
  await expect(
    dialog.getByRole('textbox', { name: 'Title for game-50.nes', exact: true }),
  ).toHaveCount(1);
});
test('stop after current completes one file and leaves later entries waiting', async ({
  page,
  fixture,
}) => {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  let started = () => {};
  const reached = new Promise<void>((r) => (started = r));
  let opens = 0;
  await page.route('**/api/v1/uploads', async (route) => {
    opens++;
    await route.continue();
  });
  await page.route('**/api/v1/uploads/*/content', async (route) => {
    started();
    await held;
    await route.continue();
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await openAddContent(page, 'Upload files');
  const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await dialog
    .getByLabel('File', { exact: true })
    .setInputFiles([generated('first.nes'), generated('second.nes')]);
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await reached;
  await dialog.getByRole('button', { name: 'Stop after current file', exact: true }).click();
  release();
  await expect(dialog.getByText('1 succeeded · 1 unfinished')).toBeVisible();
  expect(opens).toBe(1);
});
test('detail saves target the managed item and refresh revisions for subsequent files', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
  await page.getByRole('button', { name: 'Add a file', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a file', exact: true });
  await dialog
    .getByLabel('File', { exact: true })
    .setInputFiles([generated('first.sav'), generated('second.sav')]);
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog.getByText('2 succeeded · 0 unfinished')).toBeVisible();
  const manifest = await fixture.client.manifest(fixture.game.id);
  expect(manifest.files.filter((f) => f.kind === 'battery_save')).toHaveLength(3);
  expect(manifest.files.every((f) => !f.conflictOf)).toBeTruthy();
});
test('authorization loss stops later uploads and removes private UI', async ({ page, fixture }) => {
  let opens = 0;
  await page.route('**/api/v1/uploads', async (route) => {
    opens++;
    await route.fulfill({
      status: 401,
      json: { type: 'urn:ecs:problem:unauthorized', title: 'Access expired', status: 401 },
    });
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await openAddContent(page, 'Upload files');
  const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await dialog
    .getByLabel('File', { exact: true })
    .setInputFiles([generated('first.nes'), generated('second.nes')]);
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(opens).toBe(1);
});
test('library saves require an explicit managed target selected from a list that grows in bounded batches', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await page.getByRole('tab', { name: 'Saves', exact: true }).click();
  await openAddContent(page, 'Upload files');
  const dialog = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await dialog.getByLabel('File', { exact: true }).setInputFiles(generated('chosen.sav'));
  await expect(dialog.getByRole('button', { name: 'Upload', exact: true })).toBeDisabled();
  await dialog
    .getByRole('button', { name: 'Choose target for associated files', exact: true })
    .click();
  const picker = dialog.getByRole('region', { name: 'Choose managed item', exact: true });
  const listed = picker.getByRole('button').filter({ hasText: '· ID ' });
  await expect(listed.first()).toBeVisible();
  await expect(picker.getByRole('button', { name: /^(Previous|Next) items$/ })).toHaveCount(0);
  // The end of the list coming into view adds the next batch below.
  await picker.locator('.list-more').scrollIntoViewIfNeeded();
  await expect.poll(() => listed.count()).toBeGreaterThan(50);
  const selected = listed.nth(50);
  const label = await selected.textContent();
  const id = label?.split('ID ')[1] ?? 'missing';
  await selected.click();
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(dialog.getByText('1 succeeded · 0 unfinished')).toBeVisible();
  expect(
    (await fixture.client.manifest(id)).files.some(
      (f) => f.relativePath === 'chosen.sav' && f.kind === 'battery_save',
    ),
  ).toBeTruthy();
});
test('Add content offers server folders only to owners and registers in the selected library', async ({
  page,
  fixture,
}) => {
  const folder = join(fixture.directory, 'new-library-folder');
  await mkdir(folder);
  await writeFile(join(folder, 'generated.nes'), Buffer.from([78, 69, 83, 26]));
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await openAddContent(page, 'Add server folder');
  const dialog = page.getByRole('dialog', { name: 'Add server folder', exact: true });
  await dialog.getByLabel('Server folder path', { exact: true }).fill(folder);
  await dialog.getByRole('button', { name: 'Add folder', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const summaries = await fixture.client.rootSummaries({ libraryId: fixture.empty.id });
  expect(summaries.items).toHaveLength(1);
  expect(summaries.items[0]?.root.path).toBe(folder);
});
