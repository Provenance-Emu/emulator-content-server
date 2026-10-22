import { expect, signIn, test } from './fixture';

test('partial provider failures stay reviewable and can retry from the failed filter', async ({
  page,
  fixture,
}) => {
  const root = await fixture.legacy();
  await fixture.client.assignRoot(root.id, { libraryId: fixture.empty.id });
  let lookups = 0;
  await page.route('**/api/v1/sources/*/matches', async (route) => {
    const sourceId = new URL(route.request().url()).pathname.split('/')[4];
    lookups++;
    await route.fulfill({
      json: {
        sourceId,
        requestId: 'browser-retry',
        plugins: [],
        candidates: [],
        problems: lookups === 1 ? [{ providerId: 'test.provider', code: 'provider-failed' }] : [],
      },
    });
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await page.getByRole('button', { name: 'Match library', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Match library', exact: true });
  await panel.getByRole('button', { name: 'Start library matching' }).click();
  await expect(panel.getByRole('button', { name: 'Needs review (1)', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Failed (1)', exact: true }).click();
  await expect(panel.getByText('external.nes', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Review', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Retry failed games', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Failed (0)', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Retry failed games', exact: true })).toHaveCount(
    0,
  );
  await panel.getByRole('button', { name: 'No match (1)', exact: true }).click();
  await expect(panel.getByText('external.nes', { exact: true })).toBeVisible();
  expect(lookups).toBe(2);
});

test('unmatched games retry in place without a new library run', async ({ page, fixture }) => {
  const root = await fixture.legacy();
  await fixture.client.assignRoot(root.id, { libraryId: fixture.empty.id });
  let lookups = 0;
  let discoveryReads = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/browse') discoveryReads++;
  });
  await page.route('**/api/v1/sources/*/matches', async (route) => {
    lookups++;
    await route.fulfill({
      json: {
        sourceId: new URL(route.request().url()).pathname.split('/')[4],
        requestId: 'generated-unmatched-retry',
        plugins: [],
        problems: [],
        candidates:
          lookups === 1
            ? []
            : [
                {
                  id: 'generated-suggestion',
                  kind: 'metadata',
                  confidence: 'name',
                  providerId: 'test.provider',
                  title: 'Generated suggestion',
                  metadata: {},
                },
              ],
      },
    });
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await page.getByRole('button', { name: 'Match library', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Match library', exact: true });
  await panel.getByRole('button', { name: 'Start library matching' }).click();
  await expect(panel.getByRole('button', { name: 'No match (1)', exact: true })).toBeVisible();
  const reads = discoveryReads;
  await panel.getByRole('button', { name: 'Retry unmatched games', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Needs review (1)', exact: true })).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Retry unmatched games', exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByText('external.nes', { exact: true })).toBeVisible();
  expect(lookups).toBe(2);
  expect(discoveryReads).toBe(reads);
});
