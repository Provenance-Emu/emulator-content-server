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

test('review saves each category then advances to the next unresolved game with progress', async ({
  page,
  fixture,
}) => {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = await fixture.legacy('z-first.nes');
  await writeFile(join(root.path, 'z-first.json'), JSON.stringify({ title: 'A matched title' }));
  await writeFile(
    join(root.path, 'z-first.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await writeFile(join(root.path, 'y-second.nes'), new Uint8Array([78, 69, 83, 26, 1, 2, 3, 4]));
  await writeFile(join(root.path, 'y-second.json'), JSON.stringify({ title: 'B matched title' }));
  await fixture.client.assignRoot(root.id, { libraryId: fixture.empty.id });
  await fixture.client.scanRoot(root.id);
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Empty shelf', exact: true }).click();
  await page.getByRole('button', { name: 'Match library', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Match library', exact: true });
  await panel.getByText('Providers and manager', { exact: true }).click();
  await panel.getByRole('checkbox', { name: 'Include online providers', exact: true }).uncheck();
  await panel.getByRole('button', { name: 'Start library matching' }).click();
  await expect(panel.getByRole('button', { name: 'Needs review (2)', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Review', exact: true }).last().click();
  await expect(panel.getByRole('status').filter({ hasText: '2 unresolved games' })).toBeVisible();
  await panel.getByRole('button', { name: 'Next unresolved game', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'y-second.nes', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Next unresolved game', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'z-first.nes', exact: true })).toBeVisible();
  let failSave = true;
  await page.route('**/api/v1/sources/*/matches/selections', async (route) => {
    if (route.request().method() === 'PUT' && failSave) {
      failSave = false;
      return route.fulfill({
        status: 503,
        json: { type: 'urn:ecs:problem:unavailable', title: 'Generated failed save', status: 503 },
      });
    }
    return route.continue();
  });
  await panel.getByRole('button', { name: 'Save and next category', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Generated failed save');
  await expect(panel.getByRole('heading', { name: 'z-first.nes', exact: true })).toBeVisible();
  await expect(panel.getByRole('status').filter({ hasText: '2 unresolved games' })).toBeVisible();
  await panel.getByRole('button', { name: 'Save and next category', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Artwork (1)', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await panel.getByRole('button', { name: 'Save and next game', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'y-second.nes', exact: true })).toBeFocused();
  await expect(panel.getByRole('status').filter({ hasText: '1 unresolved game' })).toBeVisible();
  await panel.getByRole('button', { name: 'Save and next game', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Needs review (0)', exact: true })).toBeVisible();
  await expect(panel.getByText('2 games reviewed', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Close Match library', exact: true }).click();
  const games = page.getByRole('list', { name: 'Collection results' });
  await expect(
    page.getByRole('button', { name: 'Open A matched title', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open B matched title', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open A matched title', exact: true }).locator('img'),
  ).toBeVisible();
  const buttons = games.getByRole('button', { name: /^Open / });
  await expect(buttons.first()).toHaveAccessibleName('Open A matched title');
  await page.getByRole('combobox', { name: /^Sort/ }).selectOption('name_desc');
  await expect(buttons.first()).toHaveAccessibleName('Open B matched title');
  await page.getByRole('searchbox', { name: 'Search collection', exact: true }).fill('A matched');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(buttons).toHaveCount(1);
  await expect(buttons.first()).toHaveAccessibleName('Open A matched title');
});
