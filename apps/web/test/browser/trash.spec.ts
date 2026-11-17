import { expect, signIn, test } from './fixture';

test('a deleted game can be undone from the toast or restored from Settings', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  const open = page.getByRole('button', { name: 'Open Game 000', exact: true });
  await open.click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Moved Game 000 to the trash.' });
  await expect(toast).toBeVisible();
  await expect(open).toHaveCount(0);

  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Game 000 restored.', { exact: true })).toBeVisible();
  await expect(open).toBeVisible();
  expect((await fixture.client.manifest(fixture.game.id)).files.length).toBe(4);

  await open.click();
  await page.getByRole('button', { name: 'Move sample.sav to trash', exact: true }).click();
  await expect(page.getByText('Moved sample.sav to the trash.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download sample.sav', exact: true })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(page.getByText('Moved Game 000 to the trash.')).toBeVisible();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Trash' })
    .click();
  await expect(page.getByText('kept for 30 days')).toBeVisible();
  const list = page.getByRole('list', { name: 'Trash', exact: true });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  const file = page.getByRole('button', { name: 'Restore sample.sav', exact: true });
  await expect(file).toBeDisabled();
  await page.getByRole('button', { name: 'Restore Game 000', exact: true }).click();
  await expect(page.getByText('Game 000 restored.', { exact: true })).toBeVisible();
  await expect(file).toBeEnabled();
  await file.click();
  await expect(page.getByText('Nothing in the trash.')).toBeVisible();
  expect((await fixture.client.manifest(fixture.game.id)).files.length).toBe(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('someone who can only read sees no way to delete', async ({ page, fixture }) => {
  await signIn(page, fixture, true);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Download sample.nes', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /trash/i })).toHaveCount(0);
});
