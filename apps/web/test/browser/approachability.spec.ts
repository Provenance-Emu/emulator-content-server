import { expect, signIn, test } from './fixture';

test('phone library keeps optional filters behind a labelled disclosure and opens them on request', async ({
  page,
  fixture,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page
    .getByRole('dialog', { name: 'Library navigation' })
    .getByRole('button', { name: 'Arcade', exact: true })
    .click();
  const options = page.locator('.collection-options');
  await expect(options).not.toHaveAttribute('open');
  await expect(page.getByRole('searchbox', { name: 'Search collection' })).toBeVisible();
  const firstGame = page.getByRole('button', { name: 'Open Game 000', exact: true });
  await expect(firstGame).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('collection-mobile.png') });
  await options.getByText('Filter & sort', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Sort', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Sort', exact: true }).selectOption('name_desc');
  await expect(page.getByRole('button', { name: /^Open Game / }).first()).toHaveAccessibleName(
    'Open Game 119',
  );
  const systems = page.getByRole('group', { name: 'Systems with games', exact: true });
  await systems.getByRole('button').nth(1).click();
  await options.locator('summary').click();
  await expect(options.locator('summary')).toContainText('1 active');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(options.locator('summary')).not.toContainText('active');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('supported game puts one Play action before files and keeps mobile downloads readable', async ({
  page,
  fixture,
}, testInfo) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
  const launch = page.getByRole('region', { name: 'Play this game' });
  await expect(launch.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveCount(1);
  const files = page.getByRole('table', { name: 'Game files', exact: true });
  await expect(files.getByRole('row').nth(1)).toContainText('sample.nes');
  expect(
    await launch.evaluate((element) =>
      Boolean(element.nextElementSibling?.matches('.detail-tabs')),
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  const name = page.locator('.file-name').filter({ hasText: 'sample.nes' });
  expect((await name.boundingBox())?.width).toBeGreaterThan(250);
  await expect(
    files.getByRole('button', { name: 'Download sample.nes', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('detail-mobile.png'), fullPage: true });
});

test('unsupported browser play explains downloading and sign-in explains library access', async ({
  page,
  fixture,
}, testInfo) => {
  await page.goto(`${fixture.origin}/ui/`);
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(
    page.getByText('Use the account provided by the person who manages this library.', {
      exact: false,
    }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('login.png'), fullPage: true });
  await page.route('**/api/v1/player/core', (route) => route.fulfill({ status: 404 }));
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Arcade', exact: true }).click();
  await page.getByRole('button', { name: 'Open Game 000', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Take this game to your emulator' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Download sample.nes', exact: true }),
  ).toBeVisible();
});
