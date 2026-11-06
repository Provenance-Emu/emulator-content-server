import { expect, signIn, test } from './fixture';

test('library management opens the current library and browser Back restores the collection', async ({
  page,
  fixture,
}, testInfo) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).waitFor();
  await page.screenshot({ path: testInfo.outputPath('library-desktop.png'), fullPage: true });
  await page.getByLabel('Manage library', { exact: true }).click();
  await page.getByRole('button', { name: 'Library settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Arcade', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rename Arcade', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Empty shelf', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('library-settings-desktop.png'),
    fullPage: true,
  });
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Open Game 000', exact: true })).toBeVisible();
});

test('settings selection survives reload and uses a compact phone navigation control', async ({
  page,
  fixture,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('dialog', { name: 'Library navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Settings section', exact: true })
    .selectOption('devices');
  await expect(page).toHaveURL(/settings=devices/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Devices', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Settings section', exact: true })).toHaveValue(
    'devices',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('settings-phone.png'), fullPage: true });
});

test('changing the settings library updates the destination before a reload', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Library', exact: true })
    .selectOption({ label: 'Arcade' });
  await expect(page.getByRole('heading', { name: 'Arcade', exact: true })).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get('settingsLibrary'))
    .toBe(fixture.library.id);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Arcade', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Library', exact: true })).toHaveValue(
    fixture.library.id,
  );
});
