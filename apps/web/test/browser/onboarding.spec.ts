import { expect, signIn, test } from './fixture';

test('home offers direct library choices and a complete first-game path on a phone', async ({
  page,
  fixture,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Game 000', exact: true })).toBeVisible();
  const firstGame = await page
    .getByRole('button', { name: 'Open Game 000', exact: true })
    .boundingBox();
  expect(firstGame && firstGame.y + firstGame.height <= 844).toBeTruthy();
  await page.getByRole('button', { name: 'Add games', exact: true }).click();
  const choices = page.getByRole('dialog', { name: 'Add games', exact: true });
  await expect(choices.getByRole('button', { name: 'Upload files', exact: true })).toBeVisible();
  await expect(choices.getByRole('button', { name: 'Upload folder', exact: true })).toBeVisible();
  await expect(
    choices.getByText('Files stay on the server computer. Nothing is copied.'),
  ).toBeVisible();
  fixture.requests.length = 0;
  await choices.getByRole('button', { name: 'Add server folder', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add server folder', exact: true })).toBeVisible();
  expect(fixture.requests.some((request) => request.startsWith('POST '))).toBe(false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Add games', exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('an owner can create an empty library from home then add a first game', async ({
  page,
  fixture,
}) => {
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Create a library', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Create library', exact: true });
  await create.getByRole('textbox', { name: 'Library name', exact: true }).fill('My first games');
  await create.getByRole('button', { name: 'Create library', exact: true }).click();
  await expect(create).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'My first games', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add your first game', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Add games', exact: true })
    .getByRole('button', { name: 'Upload files', exact: true })
    .click();
  const upload = page.getByRole('dialog', { name: 'Upload files', exact: true });
  await upload.getByLabel('File', { exact: true }).setInputFiles({
    name: 'first.nes',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([78, 69, 83, 26, 0, 0, 0, 0]),
  });
  await upload
    .getByRole('combobox', { name: 'System', exact: true })
    .selectOption('com.provenance.nes');
  await upload.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(upload.getByText('1 succeeded · 0 unfinished', { exact: true })).toBeVisible();
  await upload.getByRole('button', { name: 'Close Upload files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open first', exact: true })).toBeVisible();
});

test('home and empty-state help respect reader permissions', async ({ page, fixture }) => {
  await signIn(page, fixture, true);
  await expect(page.getByRole('button', { name: 'Create a library', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open library Arcade', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add games', exact: true })).toHaveCount(0);
  await page
    .getByRole('searchbox', { name: 'Search collection', exact: true })
    .fill('missing game');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('No matching files or games.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add your first game', exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Clear filters', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Game 000', exact: true })).toBeVisible();
});

test('an unreachable server explains connection recovery without asking for a password', async ({
  page,
  fixture,
}) => {
  await page.route('**/api/v1/**', (route) => route.abort());
  await page.goto(`${fixture.origin}/ui/`);
  await expect(
    page.getByRole('heading', { name: "Can't reach your library", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Password', exact: true })).toHaveCount(0);
  await page.unroute('**/api/v1/**');
  await page.getByRole('button', { name: 'Try connecting again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
});

test('first-time home explains the next step and never creates a library on cancel', async ({
  page,
  fixture,
}) => {
  await page.route('**/api/v1/browse-libraries', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await signIn(page, fixture);
  await expect(
    page.getByRole('heading', { name: 'Welcome to your game library', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Add your games', { exact: true })).toBeVisible();
  fixture.requests.length = 0;
  await page.getByRole('button', { name: 'Create your first library', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Create library', exact: true })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  expect(fixture.requests.some((request) => request.startsWith('POST '))).toBe(false);
});

test('server-folder games explain browser support and use the actual console name', async ({
  page,
  fixture,
}) => {
  await fixture.legacy();
  await page.route('**/api/v1/player/core', (route) => route.fulfill({ status: 404 }));
  await signIn(page, fixture);
  await page.getByRole('button', { name: 'Unassigned folders', exact: true }).click();
  await page.getByRole('button', { name: 'Open external.nes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Take this game to your emulator', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Download external.nes', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('On the server', { exact: false })).toBeVisible();
});
