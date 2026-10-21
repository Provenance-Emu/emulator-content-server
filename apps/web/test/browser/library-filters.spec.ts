import { expect, signIn, test } from './fixture';

test('an empty system-chip result is shown as filtered and clearing filters restores the collection', async ({
  page,
  fixture,
}) => {
  await page.route('**/api/v1/browse?**', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (!query.has('systemIds')) return route.continue();
    const response = await route.fetch();
    await route.fulfill({ json: { ...(await response.json()), items: [], nextCursor: null } });
  });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  const systems = page.getByRole('group', { name: 'Systems with games', exact: true });
  await expect(systems.getByRole('button')).toHaveCount(2);
  await systems.getByRole('button').nth(1).click();
  await expect(page.getByText('No matching files or games.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Game 000', exact: true })).toBeVisible();
  await expect(systems.getByRole('button', { name: 'All systems', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
