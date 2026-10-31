import { expect, libraryTool, signIn, test } from './fixture.js';

test('native no-key cleanup reviews a subset, applies once and can undo after reopening', async ({
  page,
  fixture,
  browser,
}) => {
  await fixture.cleanup();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
  await libraryTool(page, 'Library activity');
  await page.getByRole('button', { name: 'Review library cleanup', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Start cleanup inspection', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Start cleanup inspection', exact: true }).click();
  await page.getByRole('button', { name: 'Close cleanup review', exact: true }).click();
  await page.getByRole('button', { name: 'Review library cleanup', exact: true }).click();
  await expect(page.getByTestId('cleanup-progress')).toContainText('completed', { timeout: 15000 });
  const cards = page.getByTestId('cleanup-proposal');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('Current');
  await expect(cards.first()).toContainText('Proposed');
  await expect(cards.first()).toContainText('missing');
  await cards.first().getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Approve 1 selected fix', exact: true }).click();
  await page.getByRole('button', { name: 'Apply approved fixes', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '1 source updated' })).toBeVisible();
  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await signIn(secondPage, fixture);
  await secondPage.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
  await libraryTool(secondPage, 'Library activity');
  await secondPage.getByRole('button', { name: 'Review library cleanup', exact: true }).click();
  await expect(
    secondPage.getByRole('button', { name: 'Undo saved fixes', exact: true }),
  ).toHaveCount(1);
  await second.close();
  await page.reload();
  await page.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
  await libraryTool(page, 'Library activity');
  await page.getByRole('button', { name: 'Review library cleanup', exact: true }).click();
  await page.getByRole('button', { name: 'Undo saved fixes', exact: true }).click();
  await expect(page.getByText('Restored the previous selections.', { exact: true })).toBeVisible();
  await page
    .getByRole('heading', { name: 'Library cleanup', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/ecs-library-cleanup-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Library cleanup', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page
    .getByRole('heading', { name: 'Library cleanup', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/ecs-library-cleanup-mobile.png' });
});
