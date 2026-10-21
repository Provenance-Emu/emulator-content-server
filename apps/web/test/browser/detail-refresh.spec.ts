import { rename } from 'node:fs/promises';
import { expect, signIn, test } from './fixture';

test('refreshing an open source checks current availability without rescanning folders', async ({
  page,
  fixture,
}) => {
  await page.clock.install();
  const root = await fixture.legacy();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  const download = page.getByRole('button', { name: 'Download external.nes', exact: true });
  await expect(download).toBeEnabled();
  await rename(root.path, `${root.path}-offline`);
  fixture.requests.length = 0;
  await page.getByRole('button', { name: 'Refresh details', exact: true }).click();
  await expect(download).toBeDisabled();
  await expect(
    page.getByText('This file is unavailable while its server folder is offline.'),
  ).toBeVisible();
  await rename(`${root.path}-offline`, root.path);
  await page.getByRole('button', { name: 'Refresh details', exact: true }).click();
  await expect(download).toBeEnabled();
  await expect(
    page.getByText('This file is unavailable while its server folder is offline.'),
  ).toHaveCount(0);
  expect(
    fixture.requests.some(
      (request) => request.includes('/scan') || request === 'GET /api/v1/sources',
    ),
  ).toBe(false);
});
