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

test('a game is a step in browser history, and arrows move between games in the list', async ({
  page,
  fixture,
}) => {
  for (const title of ['Alpha quest', 'Beta quest'])
    await fixture.client.createItem({
      libraryId: fixture.library.id,
      title,
      systemIdentifier: 'com.provenance.gba',
      md5: null,
      crc: null,
    });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Alpha quest', exact: true }).click();
  const heading = page.locator('[data-detail-heading]');
  await expect(heading).toContainText('Alpha quest');
  await expect(page.getByRole('button', { name: 'No previous game' })).toBeDisabled();
  // The next game in the list, by keyboard and then back by button.
  await page.keyboard.press('ArrowRight');
  await expect(heading).toContainText('Beta quest');
  await page.getByRole('button', { name: 'Previous game: Alpha quest' }).click();
  await expect(heading).toContainText('Alpha quest');
  // However many games were stepped through, one Back returns to the list.
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Open Beta quest', exact: true })).toBeVisible();
  await expect(heading).toHaveCount(0);
  await page.goForward();
  await expect(heading).toContainText('Alpha quest');
  // The page's own button goes the same way as Back.
  await page.getByRole('button', { name: 'Back to collection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Alpha quest', exact: true })).toBeVisible();
  await page.goForward();
  await expect(heading).toContainText('Alpha quest');
});
