import { expect, keepTasksFolded, signIn, test } from './fixture';

// A generated one-pixel PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test('a server-folder game leads with details and pictures, edits them in place, and folds occasional tasks', async ({
  page,
  fixture,
}, testInfo) => {
  await keepTasksFolded(page);
  await fixture.legacy();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Download external.nes', exact: true }),
  ).toBeVisible();
  const manage = page.getByRole('region', { name: 'Manage this game', exact: true });
  await expect(manage.locator('details').first()).toBeVisible();
  await expect(manage.locator('details[open]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Find matches', exact: true })).toBeHidden();

  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  const details = page.getByRole('region', { name: 'Details', exact: true });
  await expect(details.getByLabel('Title', { exact: true })).toBeFocused();
  await details.getByLabel('Title', { exact: true }).fill('Typed Game');
  await details.getByLabel('Publisher', { exact: true }).fill('Example Co');
  await details.getByLabel('Year', { exact: true }).fill('1991');
  await details.getByLabel('Description', { exact: true }).fill('A game typed in by hand.');
  await details.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Typed Game', exact: true }),
  ).toBeVisible();
  await expect(details.getByText('Example Co', { exact: true })).toBeVisible();
  await expect(page.locator('.game-description')).toHaveText('A game typed in by hand.');
  await expect(details.getByRole('button', { name: 'Save details', exact: true })).toHaveCount(0);

  const artwork = page.getByRole('region', { name: 'Artwork', exact: true });
  const backChooser = page.waitForEvent('filechooser');
  await artwork.getByRole('button', { name: 'Add back cover', exact: true }).click();
  await (await backChooser).setFiles({ name: 'back.png', mimeType: 'image/png', buffer: PNG });
  await artwork.getByRole('button', { name: 'View back cover', exact: true }).click();
  const viewer = page.getByRole('dialog', { name: 'Artwork for Typed Game', exact: true });
  await expect(viewer.getByRole('img', { name: 'Back cover for Typed Game' })).toBeVisible();
  // Let the dialog finish fading in before the picture is taken.
  await page.waitForTimeout(400);
  await page.screenshot({ path: testInfo.outputPath('artwork-viewer.png') });
  // Removing a picture asks first.
  await viewer.getByRole('button', { name: 'Remove back cover', exact: true }).click();
  await viewer.getByRole('button', { name: 'Keep', exact: true }).click();
  await expect(viewer.getByRole('img', { name: 'Back cover for Typed Game' })).toBeVisible();
  await viewer.getByRole('button', { name: 'Remove back cover', exact: true }).click();
  await viewer.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(viewer).toHaveCount(0);
  await expect(artwork.getByRole('button', { name: 'Add back cover', exact: true })).toBeVisible();

  const frontChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add a front cover', exact: true }).click();
  await (await frontChooser).setFiles({ name: 'front.png', mimeType: 'image/png', buffer: PNG });
  await expect(
    page.getByRole('button', { name: 'View artwork for Typed Game', exact: true }),
  ).toBeVisible();
  const bannerChooser = page.waitForEvent('filechooser');
  await artwork.getByRole('button', { name: 'Add banner', exact: true }).click();
  await (await bannerChooser).setFiles({ name: 'banner.png', mimeType: 'image/png', buffer: PNG });
  await expect(
    page.getByRole('button', { name: 'View banner for Typed Game', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('game-page-desktop.png'), fullPage: true });

  await manage.getByText('Look up details and artwork', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Find matches', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('game-page-mobile.png'), fullPage: true });
});
