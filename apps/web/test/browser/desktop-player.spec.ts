import { expect, test } from './fixture';

test('external desktop player signs in on its selected route and retains only public IDs in the URL', async ({
  page,
  fixture,
}) => {
  const rom = (await fixture.client.manifest(fixture.game.id)).files.find(
    (file) => file.kind === 'rom',
  );
  if (!rom) throw new Error('Missing generated fixture ROM');
  const target = `${fixture.origin}/play/?item=${fixture.game.id}&asset=${rom.id}`;
  await page.goto(target);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('browser-owner');
  await page.getByLabel('Password', { exact: true }).fill(fixture.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Session setup', exact: true })).toBeVisible();
  expect(page.url()).toBe(target);
  expect(new URL(page.url()).searchParams.has('token')).toBe(false);
});
