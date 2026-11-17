import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, signIn, test } from './fixture';

test('links alternate copies and plays the server-selected format from the game entry', async ({
  page,
  fixture,
}) => {
  const path = join(fixture.directory, 'Game Boy Advance');
  await mkdir(path);
  await writeFile(join(path, 'First copy.gba'), Uint8Array.of(8));
  await writeFile(join(path, 'Second copy.gba'), Uint8Array.of(12, 0));
  const root = await fixture.client.addRoot({
    path,
    label: 'Copies',
    libraryId: fixture.library.id,
  });
  await fixture.client.scanRoot(root.id);
  const sources = (await fixture.client.sources()).items.filter(
    (source) => source.rootId === root.id,
  );
  const first = sources.find((source) => source.name === 'First copy.gba');
  const second = sources.find((source) => source.name === 'Second copy.gba');
  if (!first || !second) throw new Error('Missing test copies');
  const canonical = await fixture.client.linkGameSource(first.id, { title: 'One GBA game' });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search collection' }).fill('Second copy');
  await page.getByRole('searchbox', { name: 'Search collection' }).press('Enter');
  await page.getByRole('button', { name: /Open Second copy/ }).click();
  await page.getByRole('button', { name: 'Link to a game', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Game', exact: true })
    .selectOption(canonical.itemId ?? '');
  await page.getByRole('button', { name: 'Link copy', exact: true }).click();
  await expect
    .poll(async () => (await fixture.client.gameRomCopies(canonical.itemId ?? '')).items.length)
    .toBe(2);
  await page.goto(`${fixture.origin}/ui/`);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search collection' }).fill('One GBA game');
  await page.getByRole('searchbox', { name: 'Search collection' }).press('Enter');
  await page.getByRole('button', { name: 'Open One GBA game', exact: true }).click();
  await page.getByRole('button', { name: 'View game copies', exact: true }).click();
  await expect(page.getByText(/Second copy.gba/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Play best copy', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/play/\\?.*source=${first.id}`));
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByText('WASM tick: 9')).toHaveCount(1);
});
