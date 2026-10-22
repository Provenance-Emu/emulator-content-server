import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, signIn, test } from './fixture';

test('folder watching loads lazily, enables and detects a nested move without a manual scan', async ({
  page,
  fixture,
}) => {
  const root = await fixture.legacy();
  const source = (await fixture.client.sources()).items.find((item) => item.rootId === root.id);
  expect(source).toBeTruthy();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Folder watching for External folder', exact: true }),
  ).toBeVisible();
  expect(fixture.requests.filter((request) => request.includes('/watching-policy'))).toEqual([]);
  await page
    .getByRole('button', { name: 'Folder watching for External folder', exact: true })
    .click();
  const policy = page.getByRole('dialog', { name: 'Folder watching', exact: true });
  await expect(policy.getByRole('status')).toHaveText('Folder watching is off.');
  await policy.getByRole('button', { name: 'Enable folder watching', exact: true }).click();
  await expect(
    policy.getByRole('button', { name: 'Turn off folder watching', exact: true }),
  ).toBeVisible();
  const scans = fixture.requests.filter((request) => request.endsWith('/scan')).length;
  await mkdir(join(root.path, 'nested'));
  await rename(join(root.path, 'external.nes'), join(root.path, 'nested', 'renamed.nes'));
  await expect
    .poll(
      async () => {
        const sources = fixture.catalog.listSources(root.id);
        return sources.map((item) => ({ id: item.id, path: item.relativePath }));
      },
      { timeout: 10_000 },
    )
    .toEqual([{ id: source?.id, path: 'nested/renamed.nes' }]);
  expect(fixture.requests.filter((request) => request.endsWith('/scan')).length).toBe(scans);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page
    .getByRole('button', { name: 'Folder watching for External folder', exact: true })
    .click();
  await expect(
    policy.getByRole('button', { name: 'Turn off folder watching', exact: true }),
  ).toBeVisible();
  await policy.getByRole('button', { name: 'Turn off folder watching', exact: true }).click();
  await expect(policy.getByRole('status')).toHaveText('Folder watching is off.');
  expect((await fixture.client.folderWatchPolicy(root.id)).enabled).toBe(false);
});

test('watching settings reject expired sessions and clear the modal', async ({ page, fixture }) => {
  await fixture.legacy();
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.route('**/api/v1/roots/*/watching-policy', (route) =>
    route.fulfill({ status: 401, json: { title: 'Access denied', status: 401 } }),
  );
  await page
    .getByRole('button', { name: 'Folder watching for External folder', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Folder watching', exact: true })).toHaveCount(0);
});
